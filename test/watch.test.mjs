// CI regression watch (M4.3): when to re-test, what counts as a regression, and the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compareRuns } from "../worker/src/results.js";
import { planPair, readWatchConfig, runWatch, watchSummary } from "../src/watch.js";

const NOW = Date.parse("2026-11-20T06:00:00Z");
const HASH = "a".repeat(64);
const row = (test_id, verdict, passes, applicable) => ({ test_id, verdict, passes, applicable });

test("planPair: re-test when never tested, changed, on a new suite, or stale; else skip", () => {
  const latest = { network_sha256: HASH, test_version: 9, finished_at: "2026-11-18T06:00:00Z" };
  const base = { liveHash: HASH, latest, testVersion: 9, maxAgeDays: 7, now: NOW };
  assert.deepEqual(planPair({ ...base, latest: null }), { run: true, reason: "never tested" });
  assert.match(planPair({ ...base, liveHash: "b".repeat(64) }).reason, /network changed \(aaaaaaaa → bbbbbbbb\)/);
  assert.match(planPair({ ...base, testVersion: 10 }).reason, /test suite changed \(v9 → v10\)/);
  assert.match(planPair({ ...base, now: Date.parse("2026-11-25T06:00:00Z") }).reason, /7 days ago/);
  const fresh = planPair(base);
  assert.equal(fresh.run, false);
  assert.match(fresh.reason, /48 h ago/);
});

test("compareRuns: pass → fail gates CI; pass → flaky and big pass-rate drops only warn", () => {
  const before = { score: 90, rows: [row("a", "pass", 3, 3), row("b", "pass", 3, 3), row("c", "flaky", 2, 3), row("d", "pass", 3, 3), row("e", "pass", 0, 0)] };
  const now = { score: 85, rows: [row("a", "fail", 0, 3), row("b", "flaky", 2, 3), row("c", "fail", 0, 3), row("d", "pass", 3, 3), row("e", "fail", 0, 2)] };
  const r = compareRuns(before, now);
  assert.deepEqual(r.gating.map((x) => x.test_id), ["a"]);
  assert.deepEqual(r.worse.map((x) => x.test_id), ["a", "b", "c"], "c dropped 2/3 → 0/3; e did not apply before");
  assert.equal(r.regressed, true);
  assert.equal(r.score_change, -5);
  const wobble = compareRuns({ score: 90, rows: [row("a", "pass", 3, 3)] }, { score: 88, rows: [row("a", "flaky", 2, 3)] });
  assert.equal(wobble.regressed, false, "one wobble is a warning, not a failure");
  assert.equal(wobble.worse.length, 1);
  const drop = compareRuns({ score: 90, rows: [] }, { score: 80, rows: [] });
  assert.equal(drop.regressed, true, "a 10-point drop fails on its own");
});

test("readWatchConfig: checks the file and fills defaults", () => {
  assert.deepEqual(readWatchConfig({ networks: [{ url: "https://a.example/n", models: ["m"] }] }).max_age_days, 7);
  assert.throws(() => readWatchConfig({}), /networks/);
  assert.throws(() => readWatchConfig({ networks: [{ url: "http://a.example/n", models: ["m"] }] }), /https/);
  assert.throws(() => readWatchConfig({ networks: [{ url: "https://a.example/n", models: [] }] }), /models/);
});

/** A scorecard with the given verdicts per test. */
function card(score, tests) {
  return {
    tester: { test_version: 9 },
    summary: { score, errors: 0 },
    tests: Object.entries(tests).map(([id, verdicts]) => ({ id, verdict: verdicts.every((v) => v === "pass") ? "pass" : verdicts.every((v) => v === "fail") ? "fail" : "flaky", runs: verdicts.map((verdict) => ({ verdict })) })),
  };
}

function stored(score, rows, over = {}) {
  return { run: { score, network_sha256: HASH, test_version: 9, finished_at: "2026-11-10T06:00:00Z", ...over }, results: rows };
}

test("runWatch: baseline, skip, warning, regression, unreachable network, and uploads", async () => {
  const config = readWatchConfig({ networks: [
    { url: "https://good.example/net", models: ["new-model", "fresh-model", "wobbly-model", "broken-model"] },
    { url: "https://down.example/net", models: ["m"] },
  ] });
  const db = {
    "new-model": null,
    "fresh-model": stored(100, [row("a", "pass", 3, 3)], { finished_at: "2026-11-19T06:00:00Z" }),
    "wobbly-model": stored(100, [row("a", "pass", 3, 3)]),
    "broken-model": stored(100, [row("a", "pass", 3, 3)]),
  };
  const results = {
    "new-model": card(90, { a: ["pass", "pass", "fail"] }),
    "wobbly-model": card(93, { a: ["pass", "pass", "fail"] }),
    "broken-model": card(70, { a: ["fail", "fail", "fail"] }),
  };
  const ran = [];
  const uploaded = [];
  const report = await runWatch(config, {
    testVersion: 9,
    now: NOW,
    liveHash: async (url) => { if (url.includes("down")) throw new Error("HTTP 503"); return HASH; },
    latest: async (_url, model) => db[model],
    crashTest: async (_url, model, runs) => { ran.push([model, runs]); return results[model]; },
    upload: async (c) => { uploaded.push(c); return { id: `run-${uploaded.length}`, created: true }; },
  });
  const by = Object.fromEntries(report.pairs.map((p) => [`${p.network_url.split("/")[2]}|${p.model}`, p]));
  assert.equal(by["good.example|new-model"].status, "baseline");
  assert.equal(by["good.example|fresh-model"].status, "ok");
  assert.equal(by["good.example|fresh-model"].action, "skip");
  assert.equal(by["good.example|wobbly-model"].status, "warning");
  assert.equal(by["good.example|broken-model"].status, "regressed");
  assert.deepEqual(by["good.example|broken-model"].gating.map((g) => g.test_id), ["a"]);
  assert.equal(by["down.example|m"].status, "error");
  assert.deepEqual(ran, [["new-model", 3], ["wobbly-model", 3], ["broken-model", 3]], "fresh pairs and unreachable networks are not run");
  assert.equal(uploaded.length, 3);
  assert.equal(report.regressed, true);
  assert.equal(report.failed, true);
  const md = watchSummary(report, { apiBase: "https://api.example/api" });
  assert.match(md, /❌ regression/);
  assert.match(md, /a: pass 3\/3 → fail 0\/3 \*\*\(passed before, fails now\)\*\*/);
  assert.match(md, /a: pass 3\/3 → flaky 2\/3 \(warning\)/);
  assert.match(md, /https:\/\/api.example\/api\/runs\/run-3/);
  assert.match(md, /down\.example|net/);
});

test("runWatch: a router failure is an error for that pair, not a regression; dry runs run nothing", async () => {
  const config = readWatchConfig({ networks: [{ url: "https://good.example/net", models: ["m"] }] });
  const io = {
    testVersion: 9, now: NOW, liveHash: async () => HASH, latest: async () => null,
    crashTest: async () => { throw new Error("The tester's model router refused the request (LLM HTTP 401)"); },
    upload: null,
  };
  const r = await runWatch(config, io);
  assert.equal(r.pairs[0].status, "error");
  assert.equal(r.regressed, false);
  assert.equal(r.failed, true);
  let called = false;
  const dry = await runWatch(config, { ...io, dryRun: true, crashTest: async () => { called = true; } });
  assert.equal(dry.pairs[0].status, "planned");
  assert.equal(called, false);
});
