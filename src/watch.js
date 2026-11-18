// The CI regression watch (M4.3): keep a list of networks × models tested, store every
// run in the results database, and fail when something regressed. The I/O (loading a
// network, the results API, running the tests, uploading) is passed in, so the logic is
// tested without a model or a network.

import { compareRuns, resultRows } from "../worker/src/results.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Check a watch.json config.
 *
 * :param config: The parsed file.
 * :return: The config with defaults.
 * :raises Error: When it is malformed.
 */
export function readWatchConfig(config) {
  if (!Array.isArray(config?.networks) || !config.networks.length) throw new Error("watch.json needs a non-empty networks list.");
  for (const n of config.networks) {
    if (typeof n.url !== "string" || !/^https:\/\//.test(n.url)) throw new Error(`Each network needs an https url (got ${JSON.stringify(n.url)}).`);
    if (!Array.isArray(n.models) || !n.models.length || n.models.some((m) => typeof m !== "string" || !m)) throw new Error(`${n.url}: models must be a non-empty list of names.`);
  }
  return { max_age_days: 7, runs: 3, ...config };
}

/**
 * Decide whether one (network, model) pair needs a new run.
 *
 * :param opts: {liveHash: hash of the network as served now (null if it didn't load),
 *     latest: the newest stored run row or null, testVersion: this tester's version,
 *     maxAgeDays, now: ms}.
 * :return: {run: bool, reason}.
 */
export function planPair({ liveHash, latest, testVersion, maxAgeDays, now }) {
  if (!latest) return { run: true, reason: "never tested" };
  if (liveHash && latest.network_sha256 && liveHash !== latest.network_sha256) return { run: true, reason: `network changed (${latest.network_sha256.slice(0, 8)} → ${liveHash.slice(0, 8)})` };
  if (latest.test_version < testVersion) return { run: true, reason: `test suite changed (v${latest.test_version} → v${testVersion})` };
  const ageDays = (now - Date.parse(latest.finished_at)) / DAY_MS;
  if (ageDays >= maxAgeDays) return { run: true, reason: `last run ${Math.floor(ageDays)} days ago` };
  return { run: false, reason: `up to date (tested ${Math.floor(ageDays * 24)} h ago, same network and suite)` };
}

/**
 * Run the watch.
 *
 * :param config: From readWatchConfig().
 * :param io: {
 *     liveHash(url) → hash or null,
 *     latest(url, model) → {run, results} or null (the newest stored run),
 *     crashTest(url, model, runs) → scorecard,
 *     upload(scorecard) → {id, created} (may be null when uploads are off),
 *     testVersion, now: ms, dryRun, log(text)}.
 * :return: {pairs: [...], regressed: bool, failed: bool}.
 */
export async function runWatch(config, io) {
  const log = io.log ?? (() => {});
  const pairs = [];
  for (const net of config.networks) {
    let liveHash = null;
    try {
      liveHash = await io.liveHash(net.url);
    } catch (error) {
      log(`${net.url}: could not load (${error.message})`);
    }
    for (const model of net.models) {
      const pair = { network_url: net.url, model, live_sha256: liveHash };
      pairs.push(pair);
      if (!liveHash) {
        Object.assign(pair, { action: "error", reason: "the network did not load", status: "error" });
        continue;
      }
      const stored = await io.latest(net.url, model);
      const plan = planPair({ liveHash, latest: stored?.run ?? null, testVersion: io.testVersion, maxAgeDays: config.max_age_days, now: io.now });
      Object.assign(pair, { action: plan.run ? "test" : "skip", reason: plan.reason, score_before: stored?.run?.score ?? null });
      if (!plan.run) {
        pair.status = "ok";
        continue;
      }
      if (io.dryRun) {
        pair.status = "planned";
        continue;
      }
      log(`${net.url} × ${model}: ${plan.reason}, running…`);
      let card;
      try {
        card = await io.crashTest(net.url, model, config.runs);
      } catch (error) {
        Object.assign(pair, { status: "error", error: error.message });
        continue;
      }
      pair.score_now = card.summary.score;
      pair.errors = card.summary.errors;
      try {
        const up = await io.upload?.(card);
        if (up) pair.run_id = up.id;
      } catch (error) {
        pair.upload_error = error.message;
      }
      if (!stored) {
        pair.status = "baseline";
        continue;
      }
      const cmp = compareRuns({ score: stored.run.score, rows: stored.results }, { score: card.summary.score, rows: resultRows(card) });
      Object.assign(pair, { score_change: cmp.score_change, worse: cmp.worse, gating: cmp.gating, status: cmp.regressed ? "regressed" : cmp.worse.length ? "warning" : "ok" });
      if (stored.run.network_sha256 !== liveHash) pair.note = "the network changed since the previous run";
      else if (stored.run.test_version !== card.tester.test_version) pair.note = "the test suite changed since the previous run";
    }
  }
  return { pairs, regressed: pairs.some((p) => p.status === "regressed"), failed: pairs.some((p) => p.status === "error") };
}

const ICON = { ok: "✅", baseline: "🆕", warning: "⚠️", regressed: "❌", error: "💥", planned: "🗓️" };

/**
 * A Markdown report for $GITHUB_STEP_SUMMARY and the console.
 *
 * :param report: From runWatch().
 * :param opts: {apiBase} for links to stored runs.
 * :return: Markdown text.
 */
export function watchSummary(report, { apiBase = null } = {}) {
  const name = (u) => u.split("/").pop();
  const score = (p) => (p.score_now == null ? (p.score_before ?? "–") : p.score_before == null ? `${p.score_now}` : `${p.score_before} → ${p.score_now}`);
  const lines = [
    `## Crash-test watch: ${report.regressed ? "❌ regression" : report.failed ? "💥 some pairs could not run" : "✅ no regressions"}`,
    "",
    "| | Network | Model | Why | Score |",
    "|---|---|---|---|---|",
    ...report.pairs.map((p) => `| ${ICON[p.status] ?? p.status} | ${name(p.network_url)} | ${p.model} | ${p.action === "skip" ? "skipped: " : ""}${p.reason}${p.error ? `: ${p.error}` : ""} | ${score(p)}${p.errors ? ` (${p.errors} provider-error runs)` : ""} |`),
  ];
  for (const p of report.pairs.filter((x) => x.worse?.length || x.status === "regressed" || x.upload_error)) {
    lines.push("", `### ${ICON[p.status]} ${name(p.network_url)} × ${p.model}${p.note ? ` (${p.note})` : ""}`);
    for (const w of p.worse ?? []) lines.push(`- ${w.test_id}: ${w.before} → ${w.now}${p.gating.some((g) => g.test_id === w.test_id) ? " **(passed before, fails now)**" : " (warning)"}`);
    if (p.status === "regressed" && p.score_change <= -10) lines.push(`- score dropped by ${-p.score_change}`);
    if (p.run_id && apiBase) lines.push(`- stored run: ${apiBase}/runs/${p.run_id}`);
    if (p.upload_error) lines.push(`- upload failed: ${p.upload_error}`);
  }
  lines.push("", "Fails on: a test that passed before now fails, or the score dropped by 10 or more. Pass → flaky is a warning (LLM tests vary).");
  return `${lines.join("\n")}\n`;
}
