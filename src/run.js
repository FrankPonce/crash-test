// Runs the crash-tests against one network and builds the scorecard.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadTarget, sha256Hex } from "./load.js";
import { TESTS, TEST_VERSION } from "./tests/index.js";

export const SCORECARD_SCHEMA = "crash-test/scorecard@1";
const SETUP_ERROR = /LLM HTTP (400|401|402|403|404|421|429)\b|provider key is required|Model .* is not published/;

/**
 * Summarise repeated runs of one test.
 *
 * :param runs: [{verdict, evidence}].
 * :return: {pass_rate, verdict}: "pass" when every run passed, "fail" when none passed and
 *     at least one failed, "flaky" when some passed and some failed, else "inconclusive".
 */
export function aggregate(runs) {
  const passes = runs.filter((r) => r.verdict === "pass").length;
  const fails = runs.filter((r) => r.verdict === "fail").length;
  const pass_rate = runs.length ? Math.round((passes / runs.length) * 100) / 100 : 0;
  let verdict = "inconclusive";
  if (runs.length && passes === runs.length) verdict = "pass";
  else if (passes === 0 && fails > 0) verdict = "fail";
  else if (passes > 0 && fails > 0) verdict = "flaky";
  else if (passes > 0) verdict = "pass";
  return { pass_rate, verdict };
}

/**
 * Run every test and return the scorecard.
 *
 * :param networkUrl: The network URL to test.
 * :param opts: {llm, model: {name, routerHost}, runs, only: [test ids], fetchImpl, cacheDir,
 *     onProgress(event)}. llm is the tester's model client (OpenAI-style chat()).
 * :return: The scorecard object.
 */
export async function crashTest(networkUrl, { llm, model, runs = 3, only = null, fetchImpl, cacheDir = null, onProgress = () => {} }) {
  const startedAt = new Date().toISOString();
  const { target, checks } = await loadTarget(networkUrl, { fetchImpl });
  const selected = TESTS.filter((t) => !only || only.includes(t.id));
  const cacheKey = target ? await sha256Hex(JSON.stringify([networkUrl, target.sha256, model?.name, runs, TEST_VERSION, selected.map((t) => t.id)])) : null;
  if (cacheDir && cacheKey) {
    const cached = await readCache(cacheDir, cacheKey);
    if (cached) {
      onProgress({ type: "cached" });
      return { ...cached, cached: true };
    }
  }

  const results = [];
  for (const test of selected) {
    if (!target && test.usesModel) {
      results.push({ id: test.id, title: test.title, runs: [], pass_rate: 0, verdict: "skipped", note: "The network could not be loaded." });
      continue;
    }
    const n = test.usesModel ? runs : 1;
    const out = [];
    for (let i = 0; i < n; i++) {
      onProgress({ type: "run", test: test.id, index: i + 1, of: n });
      try {
        out.push(await test.run({ target, llm, checks }));
      } catch (error) {
        out.push({ verdict: "inconclusive", evidence: `Test error: ${error?.message || error}` });
      }
      // A setup problem (wrong router, bad key, no credit) would make every run fail the
      // same way. Stop at once and cache nothing, instead of scoring the router.
      const setup = SETUP_ERROR.exec(out.at(-1).evidence || "");
      if (setup) throw new Error(`The tester's model router refused the request (${setup[0]}). Check CRASHTEST_ROUTER, CRASHTEST_API_KEY and CRASHTEST_MODEL. Details: ${out.at(-1).evidence}`);
      onProgress({ type: "result", test: test.id, index: i + 1, verdict: out.at(-1).verdict });
    }
    results.push({ id: test.id, title: test.title, runs: out, ...aggregate(out) });
  }

  const count = (v) => results.filter((r) => r.verdict === v).length;
  const scored = results.filter((r) => r.verdict !== "skipped");
  const scorecard = {
    schema: SCORECARD_SCHEMA,
    tester: { name: "crash-test", test_version: TEST_VERSION },
    target: {
      network_url: networkUrl,
      manifest_url: target ? new URL("agent-manifest.json", target.base).href : null,
      network_sha256: target?.sha256 ?? null,
      front_agent: target?.frontMan ?? null,
    },
    model: model ?? null,
    runs_per_test: runs,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    tests: results,
    summary: {
      passed: count("pass"),
      flaky: count("flaky"),
      failed: count("fail"),
      inconclusive: count("inconclusive"),
      skipped: count("skipped"),
      score: scored.length ? Math.round((scored.reduce((s, r) => s + r.pass_rate, 0) / scored.length) * 100) : 0,
    },
  };
  if (cacheDir && cacheKey) await writeCache(cacheDir, cacheKey, scorecard);
  return scorecard;
}

async function readCache(dir, key) {
  try {
    return JSON.parse(await readFile(path.join(dir, `${key}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function writeCache(dir, key, value) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${key}.json`), JSON.stringify(value, null, 2));
}
