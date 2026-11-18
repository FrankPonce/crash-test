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
    stored.judges?.length ? stored.judges.map((j) => j.name).join(", ") : (stored.judge?.name ?? null), stored.tester.test_version, stored.runs_per_test, stored.summary.score,
    stored.summary.errors ?? 0, stored.started_at, stored.finished_at, source, now, JSON.stringify(stored),
  );
  const resultStmts = resultRows(stored).map((r) => db.prepare(
    "INSERT OR IGNORE INTO results (run_id, test_id, verdict, pass_rate, passes, applicable, judged) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, r.test_id, r.verdict, r.pass_rate, r.passes, r.applicable, r.judged));
  await db.batch([runStmt, ...resultStmts]);
  return { id, created: true };
}

/**
 * Per-test rows from a scorecard, as stored in `results`. Runs that were not applicable or
 * hit a provider error don't count as applicable.
 *
 * :param card: A scorecard.
 * :return: [{test_id, verdict, pass_rate, passes, applicable, judged}].
 */
export function resultRows(card) {
  return card.tests.map((t) => {
    const applicable = t.runs.filter((r) => r.verdict !== "not_applicable" && r.verdict !== "error");
    return {
      test_id: t.id, verdict: t.verdict, pass_rate: t.pass_rate,
      passes: applicable.filter((r) => r.verdict === "pass").length, applicable: applicable.length,
      judged: t.runs.filter((r) => r.judged_by).length,
    };
  });
}

/** A drop in score this large counts as a regression on its own. */
export const SCORE_DROP = 10;

/**
 * Compare two runs of the same network on the same model, test by test. Only tests that
 * applied in both runs are compared.
 *
 * Two levels, because LLM tests vary from run to run:
 *   gating: a test that passed now fails outright, or the score dropped by SCORE_DROP or more.
 *     CI fails on these.
 *   worse:  every test that got worse, including pass → flaky and pass-rate drops of a third
 *     or more. Reported, and shown by the MCP tool, but not a CI failure on their own.
 *
 * :param before: {score, rows: resultRows()}.
 * :param now: {score, rows}.
 * :return: {score_change, worse: [{test_id, before, now}], gating: [...same], regressed: bool}.
 */
export function compareRuns(before, now) {
  const prev = new Map(before.rows.map((r) => [r.test_id, r]));
  const fmt = (r) => `${r.verdict} ${r.applicable ? `${r.passes}/${r.applicable}` : "n/a"}`;
  const worse = [];
  const gating = [];
  for (const r of now.rows) {
    const b = prev.get(r.test_id);
    if (!b || !b.applicable || !r.applicable) continue;
    const drop = b.passes / b.applicable - r.passes / r.applicable;
    const outright = b.verdict === "pass" && r.verdict === "fail";
    if (outright || (b.verdict === "pass" && r.verdict === "flaky") || drop >= 0.34) {
      const item = { test_id: r.test_id, before: fmt(b), now: fmt(r) };
      worse.push(item);
      if (outright) gating.push(item);
    }
  }
  const score_change = now.score - before.score;
  return { score_change, worse, gating, regressed: gating.length > 0 || score_change <= -SCORE_DROP };
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

// ---- queries for the MCP tools (M4.2) -----------------------------------------------------

/** Runs that only checked files have no model; keep them apart from behavioural runs. */
export const STATIC_ONLY = "(none: static only)";

/**
 * Find the stored network URL a user meant: exact, without a trailing slash, with https://
 * added, or by network name (the last path part, such as "spot_deals").
 *
 * :param db: A D1 database.
 * :param input: What the user typed.
 * :return: {url} or {candidates: [url]} when nothing or several match.
 */
export async function resolveNetwork(db, input) {
  const raw = String(input ?? "").trim().replace(/\/+$/, "");
  if (!raw) return { candidates: [] };
  const tries = [raw, /^https?:\/\//.test(raw) ? null : `https://${raw}`].filter(Boolean);
  for (const t of tries) {
    const hit = await db.prepare("SELECT network_url FROM runs WHERE network_url = ? LIMIT 1").bind(t).first();
    if (hit) return { url: hit.network_url };
  }
  const name = raw.split("/").pop().toLowerCase();
  const { results } = await db.prepare("SELECT DISTINCT network_url FROM runs").all();
  const matches = results.map((r) => r.network_url).filter((u) => {
    const last = u.split("/").pop().toLowerCase();
    return last === name || last.replace(/_/g, " ") === name.replace(/_/g, " ") || u.toLowerCase().includes(raw.toLowerCase());
  });
  return matches.length === 1 ? { url: matches[0] } : { candidates: matches };
}

/**
 * The newest run for each (network, model) pair.
 *
 * :param db: A D1 database.
 * :param filters: {network_url, model}.
 * :return: Run rows (without the scorecard), ordered by network then model.
 */
export async function latestRuns(db, { network_url = null, model = null } = {}) {
  const where = [];
  const args = [];
  if (network_url) { where.push("network_url = ?"); args.push(network_url); }
  if (model) { where.push("model = ?"); args.push(model); }
  const sql = `SELECT ${RUN_COLUMNS} FROM (
      SELECT ${RUN_COLUMNS}, ROW_NUMBER() OVER (PARTITION BY network_url, model ORDER BY finished_at DESC, id) AS rn
      FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ) WHERE rn = 1 ORDER BY network_url, model`;
  const { results } = await db.prepare(sql).bind(...args).all();
  return results;
}

/**
 * The newest runs for one (network, model) pair, newest first.
 *
 * :param db: A D1 database.
 * :param network_url: The network.
 * :param model: The model.
 * :param limit: How many.
 * :return: Run rows.
 */
export async function recentRuns(db, network_url, model, limit = 2) {
  const { results } = await db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE network_url = ? AND model = ? ORDER BY finished_at DESC, id LIMIT ?`)
    .bind(network_url, model, limit).all();
  return results;
}

/**
 * Per-test results for several runs at once.
 *
 * :param db: A D1 database.
 * :param ids: Run ids.
 * :return: Map of run id → [result rows].
 */
export async function resultsFor(db, ids) {
  const out = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const { results } = await db.prepare(`SELECT run_id, test_id, verdict, pass_rate, passes, applicable, judged FROM results WHERE run_id IN (${ids.map(() => "?").join(",")}) ORDER BY rowid`)
    .bind(...ids).all();
  for (const r of results) out.get(r.run_id).push(r);
  return out;
}

/**
 * The stored scorecard of one run.
 *
 * :param db: A D1 database.
 * :param id: Run id.
 * :return: The scorecard object or null.
 */
export async function scorecardOf(db, id) {
  const row = await db.prepare("SELECT scorecard_json FROM runs WHERE id = ?").bind(id).first();
  return row ? JSON.parse(row.scorecard_json) : null;
}
