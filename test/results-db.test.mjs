// The results database (M4.1): the Worker's own SQL and endpoints, over node:sqlite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { migratedDb } from "./d1-sqlite.mjs";
import { getRun, ingestScorecard, listRuns, scorecardId, validateScorecard } from "../worker/src/results.js";
import worker from "../worker/src/index.js";

const TOKEN = "test-ingest-token-0123456789abcdef";
const real = JSON.parse(await readFile(new URL("../results/2026-11-17-v9-charge_planner-alibaba_qwen3.8-flash.json", import.meta.url), "utf8"));

/** A small valid scorecard; override fields to make variants. */
function card(over = {}) {
  return {
    schema: "crash-test/scorecard@1",
    tester: { name: "crash-test", test_version: 9 },
    target: { network_url: "https://a.example/net", manifest_url: "https://a.example/agent-manifest.json", network_sha256: "a".repeat(64), front_agent: "front" },
    model: { name: "m1", routerHost: "router.example" },
    judge: null,
    runs_per_test: 3,
    started_at: "2026-11-18T10:00:00.000Z",
    finished_at: "2026-11-18T10:05:00.000Z",
    tests: [
      { id: "out_of_scope", title: "Declines", runs: [{ verdict: "pass" }, { verdict: "pass" }, { verdict: "fail" }], pass_rate: 0.67, verdict: "flaky" },
      { id: "unknown_outcome", title: "Unknown", runs: [{ verdict: "not_applicable" }, { verdict: "pass", judged_by: "j" }, { verdict: "error" }], pass_rate: 1, verdict: "pass" },
    ],
    summary: { passed: 1, flaky: 1, failed: 0, inconclusive: 0, skipped: 0, not_applicable: 0, errors: 1, score: 84 },
    ...over,
  };
}

test("validation accepts real scorecards and rejects malformed ones with a reason", () => {
  assert.deepEqual(validateScorecard(real), { ok: true });
  assert.deepEqual(validateScorecard(card()), { ok: true });
  const cases = [
    [null, /JSON object/],
    [card({ schema: "other" }), /schema/],
    [card({ target: { network_url: "javascript:alert(1)" } }), /network_url/],
    [card({ model: {} }), /model.name/],
    [card({ tester: { test_version: "9" } }), /test_version/],
    [card({ started_at: "yesterday" }), /ISO/],
    [card({ tests: [] }), /non-empty/],
    [card({ tests: [{ id: "x", verdict: "great", pass_rate: 1, runs: [] }] }), /unknown verdict/],
    [card({ tests: [{ id: "x", verdict: "pass", pass_rate: 2, runs: [] }] }), /pass_rate/],
    [card({ tests: [{ id: "x", verdict: "pass", pass_rate: 1, runs: [] }, { id: "x", verdict: "pass", pass_rate: 1, runs: [] }] }), /duplicate/],
    [card({ summary: { score: 101 } }), /score/],
  ];
  for (const [c, reason] of cases) {
    const r = validateScorecard(c);
    assert.equal(r.ok, false);
    assert.match(r.reason, reason);
  }
});

test("ingest stores a run and its results once; the id ignores key order and the cached flag", async () => {
  const db = await migratedDb();
  const first = await ingestScorecard(db, card(), { source: "cli", now: "2026-11-18T11:00:00.000Z" });
  assert.equal(first.created, true);
  assert.match(first.id, /^[0-9a-f]{64}$/);
  const reordered = Object.fromEntries(Object.entries(card()).reverse());
  const again = await ingestScorecard(db, { ...reordered, cached: true }, { source: "ci" });
  assert.deepEqual(again, { id: first.id, created: false });
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM runs").first()).n, 1);
  const got = await getRun(db, first.id);
  assert.equal(got.run.source, "cli", "the first upload wins");
  assert.equal(got.run.score, 84);
  assert.equal(got.run.errors, 1);
  assert.deepEqual(got.results.map((r) => [r.test_id, r.verdict, r.passes, r.applicable, r.judged]), [
    ["out_of_scope", "flaky", 2, 3, 0],
    ["unknown_outcome", "pass", 1, 1, 1], // not_applicable and error runs are not applicable
  ]);
  assert.equal(got.scorecard.cached, undefined);
  await assert.rejects(ingestScorecard(db, card(), { source: "someone" }), /source/);
});

test("listRuns filters by network and model, newest first, with a limit", async () => {
  const db = await migratedDb();
  await ingestScorecard(db, real, { source: "matrix" });
  await ingestScorecard(db, card({ finished_at: "2026-11-18T09:00:00.000Z" }), { source: "cli" });
  await ingestScorecard(db, card({ finished_at: "2026-11-18T12:00:00.000Z" }), { source: "cli" });
  await ingestScorecard(db, card({ model: { name: "m2" } }), { source: "cli" });
  const all = await listRuns(db);
  assert.equal(all.length, 4);
  assert.equal(all[0].finished_at, "2026-11-18T12:00:00.000Z");
  assert.equal("scorecard_json" in all[0], false, "lists stay small");
  assert.equal((await listRuns(db, { network_url: "https://a.example/net", model: "m1" })).length, 2);
  assert.equal((await listRuns(db, { network_url: real.target.network_url })).length, 1);
  assert.equal((await listRuns(db, { limit: 1 })).length, 1);
  assert.equal((await listRuns(db, { limit: 9999 })).length, 4);
});

test("scorecardId is stable and changes when any content changes", async () => {
  assert.equal(await scorecardId(card()), await scorecardId(card()));
  assert.notEqual(await scorecardId(card()), await scorecardId(card({ runs_per_test: 2 })));
});

// ---- HTTP endpoints ---------------------------------------------------------------------

async function call(env, method, path, { body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await worker.fetch(new Request(`https://crashtest.example${path}`, { method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), env);
  return { status: res.status, body: await res.json(), cors: res.headers.get("access-control-allow-origin") };
}

test("POST /api/results needs the token, valid JSON, a known source and a valid scorecard", async () => {
  const env = { DB: await migratedDb(), INGEST_TOKEN: TOKEN };
  assert.equal((await call(env, "POST", "/api/results", { body: { source: "cli", scorecard: card() } })).status, 401);
  assert.equal((await call(env, "POST", "/api/results", { body: { source: "cli", scorecard: card() }, token: "wrong" })).status, 401);
  assert.equal((await call(env, "POST", "/api/results", { body: "not json", token: TOKEN })).status, 400);
  assert.match((await call(env, "POST", "/api/results", { body: { source: "x", scorecard: card() }, token: TOKEN })).body.error.message, /source/);
  assert.match((await call(env, "POST", "/api/results", { body: { source: "cli", scorecard: card({ schema: "x" }) }, token: TOKEN })).body.error.message, /schema/);
  const created = await call(env, "POST", "/api/results", { body: { source: "cli", scorecard: card() }, token: TOKEN });
  assert.equal(created.status, 201);
  assert.equal(created.body.created, true);
  const again = await call(env, "POST", "/api/results", { body: { source: "cli", scorecard: card() }, token: TOKEN });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, created.body.id);
  assert.equal(created.cors, null, "uploads are not open to browsers on other sites");
  // Without a configured token, uploads are off rather than open.
  assert.equal((await call({ DB: env.DB }, "POST", "/api/results", { body: { source: "cli", scorecard: card() }, token: "" })).status, 503);
  const big = { source: "cli", scorecard: card({ padding: "x".repeat(1024 * 1024) }) };
  assert.equal((await call(env, "POST", "/api/results", { body: big, token: TOKEN })).status, 413);
});

test("the CLI's uploader stores a scorecard through the Worker, and reports refusals", async () => {
  const { uploadScorecard, uploadFromEnv } = await import("../src/upload.js");
  const env = { DB: await migratedDb(), INGEST_TOKEN: TOKEN };
  const fetchImpl = (url, init) => worker.fetch(new Request(url, init), env);
  const r = await uploadScorecard(real, { source: "cli", token: TOKEN, url: "https://crashtest.example/api/results", fetchImpl });
  assert.equal(r.created, true);
  assert.equal((await listRuns(env.DB))[0].id, r.id);
  await assert.rejects(uploadScorecard(real, { source: "cli", token: "nope", url: "https://crashtest.example/api/results", fetchImpl }), /HTTP 401/);
  await assert.rejects(uploadScorecard(real, { source: "cli", token: "" }), /INGEST_TOKEN/);
  assert.equal(uploadFromEnv({}), null);
  assert.deepEqual(uploadFromEnv({ INGEST_TOKEN: "t" }), { token: "t", url: "https://crashtest.frankmp12357.workers.dev/api/results" });
});

test("GET /api/runs and /api/runs/<id> are public and read-only", async () => {
  // Paths outside /api/ go to static assets, which answer 404 for unknown files.
  const ASSETS = { fetch: async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }) };
  const env = { DB: await migratedDb(), INGEST_TOKEN: TOKEN, ASSETS };
  const { body: { id } } = await call(env, "POST", "/api/results", { body: { source: "matrix", scorecard: real }, token: TOKEN });
  const list = await call(env, "GET", `/api/runs?network_url=${encodeURIComponent(real.target.network_url)}`);
  assert.equal(list.status, 200);
  assert.equal(list.cors, "*");
  assert.equal(list.body.runs.length, 1);
  assert.equal(list.body.runs[0].score, real.summary.score);
  const one = await call(env, "GET", `/api/runs/${id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.results.length, 12);
  assert.equal(one.body.scorecard.target.network_sha256, real.target.network_sha256);
  assert.equal((await call(env, "GET", `/api/runs/${"0".repeat(64)}`)).status, 404);
  assert.equal((await call(env, "GET", "/api/runs/../../secrets")).status, 404);
  assert.equal((await call(env, "DELETE", `/api/runs/${id}`)).status, 404);
});
