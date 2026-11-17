// The results database (D1): validate and store scorecards, and query them. Plain SQL over
// the D1 API (prepare/bind/all/first/run/batch), so the same code runs in the Worker and,
// in tests, over node:sqlite through a small adapter. The MCP tools (M4.2) build on this.

import canonicalize from "canonicalize";

export const SCORECARD_SCHEMA = "crash-test/scorecard@1";
export const SOURCES = ["cli", "ci", "matrix", "attestation", "backfill", "site"];
const VERDICTS = new Set(["pass", "fail", "flaky", "inconclusive", "skipped", "not_applicable", "error"]);
const RUN_VERDICTS = new Set(["pass", "fail", "inconclusive", "not_applicable", "error"]);
const MAX_TESTS = 50;
const MAX_RUNS_PER_TEST = 20;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Check that an uploaded object is a crash-test scorecard we can store.
 *
 * :param card: The parsed JSON.
 * :return: {ok: true} or {ok: false, reason}.
 */
export function validateScorecard(card) {
  const bad = (reason) => ({ ok: false, reason });
  if (!card || typeof card !== "object" || Array.isArray(card)) return bad("not a JSON object");
  if (card.schema !== SCORECARD_SCHEMA) return bad(`schema must be ${SCORECARD_SCHEMA}`);
  const url = card.target?.network_url;
  if (typeof url !== "string" || !/^https?:\/\/[^\s]+$/.test(url) || url.length > 500) return bad("target.network_url must be an http(s) URL");
  const hash = card.target?.network_sha256;
  if (hash !== null && hash !== undefined && !/^[0-9a-f]{64}$/.test(hash)) return bad("target.network_sha256 must be 64 hex characters or null");
  if (typeof card.model?.name !== "string" || !card.model.name || card.model.name.length > 200) return bad("model.name is required");
  if (!Number.isInteger(card.tester?.test_version) || card.tester.test_version < 1) return bad("tester.test_version must be a positive integer");
  if (!Number.isInteger(card.runs_per_test) || card.runs_per_test < 1 || card.runs_per_test > MAX_RUNS_PER_TEST) return bad("runs_per_test must be 1–20");
  if (!ISO.test(card.started_at ?? "") || !ISO.test(card.finished_at ?? "")) return bad("started_at and finished_at must be ISO UTC timestamps");
  if (!Array.isArray(card.tests) || !card.tests.length || card.tests.length > MAX_TESTS) return bad("tests must be a non-empty list (at most 50)");
  const ids = new Set();
  for (const t of card.tests) {
    if (typeof t?.id !== "string" || !/^[a-z0-9_]{1,64}$/.test(t.id)) return bad("each test needs an id like out_of_scope");
    if (ids.has(t.id)) return bad(`duplicate test id ${t.id}`);
    ids.add(t.id);
    if (!VERDICTS.has(t.verdict)) return bad(`test ${t.id} has an unknown verdict`);
    if (typeof t.pass_rate !== "number" || t.pass_rate < 0 || t.pass_rate > 1) return bad(`test ${t.id} pass_rate must be 0–1`);
    if (!Array.isArray(t.runs) || t.runs.length > MAX_RUNS_PER_TEST) return bad(`test ${t.id} runs must be a list (at most 20)`);
    if (t.runs.some((r) => !RUN_VERDICTS.has(r?.verdict))) return bad(`test ${t.id} has a run with an unknown verdict`);
  }
  const score = card.summary?.score;
  if (!Number.isInteger(score) || score < 0 || score > 100) return bad("summary.score must be 0–100");
  return { ok: true };
}

/** The run id: SHA-256 of the canonical scorecard, without the local "cached" flag. */
export async function scorecardId(card) {
  const { cached, ...rest } = card;
  const bytes = new TextEncoder().encode(canonicalize(rest));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Store a scorecard. Idempotent: the same scorecard gives the same id and no new rows.
 *
 * :param db: A D1 database.
 * :param card: A scorecard that passed validateScorecard().
 * :param opts: {source, now}.
 * :return: {id, created}.
 */
export async function ingestScorecard(db, card, { source, now = new Date().toISOString() }) {
  if (!SOURCES.includes(source)) throw new Error(`source must be one of ${SOURCES.join(", ")}`);
  const { cached, ...stored } = card;
  const id = await scorecardId(stored);
  const existing = await db.prepare("SELECT id FROM runs WHERE id = ?").bind(id).first();
  if (existing) return { id, created: false };
  const runStmt = db.prepare(
    `INSERT OR IGNORE INTO runs (id, network_url, network_sha256, model, router, judge, test_version, runs_per_test,
       score, errors, started_at, finished_at, source, ingested_at, scorecard_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, stored.target.network_url, stored.target.network_sha256 ?? null, stored.model.name, stored.model.routerHost ?? null,
    stored.judge?.name ?? null, stored.tester.test_version, stored.runs_per_test, stored.summary.score,
    stored.summary.errors ?? 0, stored.started_at, stored.finished_at, source, now, JSON.stringify(stored),
  );
  const resultStmts = stored.tests.map((t) => {
    const applicable = t.runs.filter((r) => r.verdict !== "not_applicable" && r.verdict !== "error");
    return db.prepare(
      "INSERT OR IGNORE INTO results (run_id, test_id, verdict, pass_rate, passes, applicable, judged) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, t.id, t.verdict, t.pass_rate, applicable.filter((r) => r.verdict === "pass").length, applicable.length,
      t.runs.filter((r) => r.judged_by).length);
  });
  await db.batch([runStmt, ...resultStmts]);
  return { id, created: true };
}

const RUN_COLUMNS = "id, network_url, network_sha256, model, router, judge, test_version, runs_per_test, score, errors, started_at, finished_at, source, ingested_at";

/**
 * Recent runs, newest first, without the full scorecard.
 *
 * :param db: A D1 database.
 * :param filters: {network_url, model, limit (default 50, max 200)}.
 * :return: A list of run rows.
 */
export async function listRuns(db, { network_url = null, model = null, limit = 50 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 50));
  const where = [];
  const args = [];
  if (network_url) { where.push("network_url = ?"); args.push(network_url); }
  if (model) { where.push("model = ?"); args.push(model); }
  const sql = `SELECT ${RUN_COLUMNS} FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY finished_at DESC, id LIMIT ?`;
  const { results } = await db.prepare(sql).bind(...args, n).all();
  return results;
}

/**
 * One run with its per-test results and the full scorecard.
 *
 * :param db: A D1 database.
 * :param id: The run id.
 * :return: {run, results, scorecard} or null.
 */
export async function getRun(db, id) {
  const row = await db.prepare(`SELECT ${RUN_COLUMNS}, scorecard_json FROM runs WHERE id = ?`).bind(id).first();
  if (!row) return null;
  const { results } = await db.prepare("SELECT test_id, verdict, pass_rate, passes, applicable, judged FROM results WHERE run_id = ? ORDER BY rowid").bind(id).all();
  const { scorecard_json, ...run } = row;
  return { run, results, scorecard: JSON.parse(scorecard_json) };
}
