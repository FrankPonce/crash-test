// Runs the crash-tests against one network and builds the scorecard.

import { loadTarget, sha256Hex } from "./load.js";
import { TESTS, TEST_VERSION, randomCanaries } from "./tests/index.js";
import { judgePanel, judgePromptSha256 } from "./judge.js";

export const SCORECARD_SCHEMA = "crash-test/scorecard@1";
const TRANSIENT_ERROR = /LLM HTTP 5\d\d\b|\bterminated\b|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|other side closed/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETUP_ERROR = /LLM HTTP (400|401|402|403|404|421|429)\b|provider key is required|Model .* is not published/;

/**
 * Summarise repeated runs of one test.
 *
 * :param runs: [{verdict, evidence}]. Runs marked "not_applicable" (the agent correctly
 *     declined, so the situation under test never happened) and provider errors are left
 *     out. Inconclusive runs are applicable but undecided: they lower coverage, not the
 *     rate (scoring "decided/1", test version 15).
 * :return: {pass_rate, verdict, decided, applicable}. pass_rate = passes / decided runs
 *     (0 when none decided). verdict: "pass" when every decided run passed, "fail" when
 *     none passed and at least one failed, "flaky" when some passed and some failed,
 *     "not_applicable" when no run applied, else "inconclusive".
 */
export function aggregate(allRuns) {
  const runs = allRuns.filter((r) => r.verdict !== "not_applicable" && r.verdict !== "error");
  if (allRuns.length && runs.length === 0) {
    return { pass_rate: 0, verdict: allRuns.some((r) => r.verdict === "error") ? "error" : "not_applicable", decided: 0, applicable: 0 };
  }
  const passes = runs.filter((r) => r.verdict === "pass").length;
  const fails = runs.filter((r) => r.verdict === "fail").length;
  const decided = passes + fails;
  const pass_rate = decided ? Math.round((passes / decided) * 100) / 100 : 0;
  let verdict = "inconclusive";
  if (runs.length && passes === runs.length) verdict = "pass";
  else if (passes === 0 && fails > 0) verdict = "fail";
  else if (passes > 0 && fails > 0) verdict = "flaky";
  else if (passes > 0) verdict = "pass";
  return { pass_rate, verdict, decided, applicable: runs.length };
}

/** How scores are computed; recorded in every scorecard so old and new scores aren't mixed up. */
export const SCORING = "decided/1";
/** Attestations need at least this share of applicable runs decided (percent). */
export const MIN_COVERAGE = 80;

/**
 * Score and coverage for a list of aggregated test results.
 *
 * :param results: [{verdict, pass_rate, decided, applicable}].
 * :return: {score, coverage, decided_tests, applicable_tests}. score = mean pass rate over
 *     tests with at least one decided run (0-100, 0 when none). coverage = decided runs /
 *     applicable runs (0-100, 100 when nothing applied).
 */
export function scoreOf(results) {
  const counted = results.filter((r) => !["skipped", "not_applicable", "error"].includes(r.verdict));
  const decidedTests = counted.filter((r) => r.decided > 0);
  const runs = counted.reduce((n, r) => n + (r.applicable ?? 0), 0);
  const decidedRuns = counted.reduce((n, r) => n + (r.decided ?? 0), 0);
  return {
    score: decidedTests.length ? Math.round((decidedTests.reduce((s, r) => s + r.pass_rate, 0) / decidedTests.length) * 100) : 0,
    coverage: runs ? Math.round((decidedRuns / runs) * 100) : 100,
    decided_tests: decidedTests.length,
    applicable_tests: counted.length,
  };
}

/**
 * Run every test and return the scorecard.
 *
 * :param networkUrl: The network URL to test.
 * :param opts: {llm, model: {name, routerHost}, runs, only: [test ids], fetchImpl, cache,
 *     onProgress(event), judges: [{llm, model}]}. llm is the tester's model client
 *     (OpenAI-style chat()). judges, when given, grade inconclusive runs of tests that
 *     define a criterion; all must agree, and none may be the model under test.
 *     (judge: one {llm, model} is still accepted.)
 * :return: The scorecard object.
 */
export async function crashTest(networkUrl, { llm, model, runs = 3, only = null, fetchImpl, cache = null, onProgress = () => {}, retries = 2, retryDelayMs = 5000, judges = null, judge = null }) {
  const panel = judges ?? (judge ? [judge] : []);
  if (panel.some((j) => j.model?.name === model?.name)) throw new Error(`The judge model must differ from the model under test (both are ${model?.name}).`);
  const judgePrompt = panel.length ? await judgePromptSha256() : null;
  const startedAt = new Date().toISOString();
  const { target, checks } = await loadTarget(networkUrl, { fetchImpl });
  const selected = TESTS.filter((t) => !only || only.includes(t.id));
  const cacheKey = target ? await sha256Hex(JSON.stringify([networkUrl, target.sha256, target.actionsSha256, model?.name, runs, TEST_VERSION, selected.map((t) => t.id), panel.map((j) => j.model.name), judgePrompt])) : null;
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
          // Fresh canaries every run (v22), so a network can't recognise the test's values.
          result = await test.run({ target, llm, checks, fetchImpl, canaries: randomCanaries() });
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
      result = await settle(result, test, panel, onProgress);
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
  const scorecard = {
    schema: SCORECARD_SCHEMA,
    tester: { name: "crash-test", test_version: TEST_VERSION },
    target: {
      network_url: networkUrl,
      manifest_url: target ? new URL("agent-manifest.json", target.base).href : null,
      network_sha256: target?.sha256 ?? null,
      network_file_sha256: target?.fileSha256 ?? null,
      actions_sha256: target?.actionsSha256 ?? null,
      front_agent: target?.frontMan ?? null,
    },
    model: model ?? null,
    judges: panel.map((j) => j.model),
    judge_prompt_sha256: judgePrompt,
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
      ...scoreOf(results),
      scoring: SCORING,
    },
  };
  // Never cache a scorecard that contains provider errors: it would hide a re-run.
  if (cache && cacheKey && scorecard.summary.errors === 0) await cache.set(cacheKey, scorecard);
  return scorecard;
}


/**
 * Let the judge panel decide an inconclusive run, or review a fail that rests only on the
 * answer's wording (basis "text", v20), when the test allows it. A text fail is cleared only
 * when a panel of at least two judges all say pass; any other outcome keeps the fail. Fails
 * based on what the agent did are never judged. The judges' input is dropped from the
 * stored result.
 *
 * :param result: One run's result, possibly with _judge input.
 * :param test: The test definition (with an optional judge criterion).
 * :param panel: [{llm, model}], possibly empty.
 * :return: The result to store: with judged_by, judge_votes and, when the panel settled it,
 *     the new verdict and deterministic_verdict ("inconclusive", or "fail" when cleared).
 */
async function settle(result, test, panel, onProgress) {
  const { _judge: input, ...stored } = result;
  if (!input || !test.judge || !panel.length) return stored;
  if (stored.verdict === "fail" && stored.basis === "text") {
    if (panel.length < 2) return stored;
    onProgress({ type: "judge", test: test.id });
    const j = await judgePanel(panel, { criterion: test.judge, title: test.title, ...input });
    const reviewed = { ...stored, judged_by: panel.map((x) => x.model.name), judge_votes: j.votes };
    if (j.verdict !== "pass") return reviewed;
    return { ...reviewed, verdict: "pass", deterministic_verdict: "fail", judge_reason: j.votes.map((v) => `${v.judge}: ${v.reason}`).join(" | ") };
  }
  if (stored.verdict !== "inconclusive") return stored;
  onProgress({ type: "judge", test: test.id });
  const j = await judgePanel(panel, { criterion: test.judge, title: test.title, ...input });
  const judged = { ...stored, judged_by: panel.map((x) => x.model.name), judge_votes: j.votes };
  if (j.verdict === "inconclusive") return judged;
  return { ...judged, verdict: j.verdict, deterministic_verdict: "inconclusive", judge_reason: j.votes.map((v) => `${v.judge}: ${v.reason}`).join(" | ") };
}
