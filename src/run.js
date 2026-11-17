// Runs the crash-tests against one network and builds the scorecard.

import { loadTarget, sha256Hex } from "./load.js";
import { TESTS, TEST_VERSION } from "./tests/index.js";

export const SCORECARD_SCHEMA = "crash-test/scorecard@1";
const TRANSIENT_ERROR = /LLM HTTP 5\d\d\b|\bterminated\b|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|other side closed/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETUP_ERROR = /LLM HTTP (400|401|402|403|404|421|429)\b|provider key is required|Model .* is not published/;

/**
 * Summarise repeated runs of one test.
 *
 * :param runs: [{verdict, evidence}]. Runs marked "not_applicable" (the agent correctly
 *     declined, so the situation under test never happened) are left out of the rate.
 * :return: {pass_rate, verdict}: "pass" when every applicable run passed, "fail" when none
 *     passed and at least one failed, "flaky" when some passed and some failed,
 *     "not_applicable" when no run applied, else "inconclusive".
 */
export function aggregate(allRuns) {
  const runs = allRuns.filter((r) => r.verdict !== "not_applicable" && r.verdict !== "error");
  if (allRuns.length && runs.length === 0) {
    return { pass_rate: 0, verdict: allRuns.some((r) => r.verdict === "error") ? "error" : "not_applicable" };
  }
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
 * :param opts: {llm, model: {name, routerHost}, runs, only: [test ids], fetchImpl, cache,
 *     onProgress(event)}. llm is the tester's model client (OpenAI-style chat()).
 * :return: The scorecard object.
 */
export async function crashTest(networkUrl, { llm, model, runs = 3, only = null, fetchImpl, cache = null, onProgress = () => {}, retries = 2, retryDelayMs = 5000 }) {
  const startedAt = new Date().toISOString();
  const { target, checks } = await loadTarget(networkUrl, { fetchImpl });
  const selected = TESTS.filter((t) => !only || only.includes(t.id));
  const cacheKey = target ? await sha256Hex(JSON.stringify([networkUrl, target.sha256, model?.name, runs, TEST_VERSION, selected.map((t) => t.id)])) : null;
  if (cache && cacheKey) {
    const cached = await cache.get(cacheKey);
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
      // Provider hiccups (5xx, dropped connections) say nothing about the agent: retry
      // with backoff, and if they persist, mark the run "error" (left out of the score).
      let result;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          result = await test.run({ target, llm, checks, fetchImpl });
        } catch (error) {
          result = { verdict: "inconclusive", evidence: `Test error: ${error?.message || error}` };
        }
        if (!TRANSIENT_ERROR.test(result.evidence || "")) break;
        if (attempt < retries) {
          onProgress({ type: "retry", test: test.id, index: i + 1, attempt: attempt + 1 });
          await sleep(retryDelayMs * 2 ** attempt);
        } else {
          result = { verdict: "error", evidence: `Model provider error after ${retries + 1} attempts: ${result.evidence}` };
        }
      }
      out.push(result);
      // A setup problem (wrong router, bad key, no credit) would make every run fail the
      // same way. Stop at once and cache nothing, instead of scoring the router.
      const setup = SETUP_ERROR.exec(out.at(-1).evidence || "");
      if (setup) throw new Error(`The tester's model router refused the request (${setup[0]}). Check CRASHTEST_ROUTER, CRASHTEST_API_KEY and CRASHTEST_MODEL. Details: ${out.at(-1).evidence}`);
      onProgress({ type: "result", test: test.id, index: i + 1, verdict: out.at(-1).verdict });
    }
    results.push({ id: test.id, title: test.title, runs: out, ...aggregate(out) });
  }

  const count = (v) => results.filter((r) => r.verdict === v).length;
  const scored = results.filter((r) => !["skipped", "not_applicable", "error"].includes(r.verdict));
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
      not_applicable: count("not_applicable"),
      errors: results.reduce((n, r) => n + r.runs.filter((x) => x.verdict === "error").length, 0),
      score: scored.length ? Math.round((scored.reduce((s, r) => s + r.pass_rate, 0) / scored.length) * 100) : 0,
    },
  };
  // Never cache a scorecard that contains provider errors: it would hide a re-run.
  if (cache && cacheKey && scorecard.summary.errors === 0) await cache.set(cacheKey, scorecard);
  return scorecard;
}

