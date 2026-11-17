#!/usr/bin/env node
// crash-test <network-url> [--runs 3] [--only id,id] [--json] [--no-cache] [--no-judge] [--upload] [--attest out.jws]

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { attest, signingKeyFromEnv } from "./attest.js";
import { crashTest } from "./run.js";
import { fileCache } from "./file-cache.js";
import { judgeFromEnv, modelFromEnv } from "./model.js";
import { TESTS } from "./tests/index.js";
import { uploadFromEnv, uploadScorecard } from "./upload.js";

const ICON = { pass: "PASS ", fail: "FAIL ", flaky: "FLAKY", inconclusive: "?    ", skipped: "SKIP ", not_applicable: "N/A  ", error: "ERROR" };

function parseArgs(argv) {
  const opts = { runs: 3, json: false, cache: true, only: null, url: null, judge: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") opts.runs = Math.max(1, Math.min(10, Number(argv[++i]) || 3));
    else if (a === "--only") opts.only = String(argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--json") opts.json = true;
    else if (a === "--no-cache") opts.cache = false;
    else if (a === "--no-judge") opts.judge = false;
    else if (a === "--upload") opts.upload = true;
    else if (a === "--attest") opts.attest = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (!opts.url) opts.url = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.url) {
    console.log("Usage: crash-test <network-url> [--runs 3] [--only static_validity,out_of_scope] [--json] [--no-cache] [--no-judge] [--upload] [--attest out.jws]\n"
      + "Model: CRASHTEST_API_KEY, CRASHTEST_ROUTER (default hosted Otari), CRASHTEST_MODEL.\n"
      + "Judge for unclear runs: CRASHTEST_JUDGE_MODELS (comma-separated; the first one not under test is used; \"off\" disables).\n"
      + "Upload: INGEST_TOKEN, CRASHTEST_RESULTS (default: the public tester's /api/results).\n"
      + "Attest: CRASHTEST_SIGNING_KEY (tester private JWK file), CRASHTEST_ORIGIN (where its key directory is served).");
    process.exit(opts.url ? 0 : 2);
  }
  const upload = opts.upload ? uploadFromEnv() : null;
  if (opts.upload && !upload) throw new Error("--upload needs INGEST_TOKEN (for example in .env).");
  const needsModel = TESTS.some((t) => t.usesModel && (!opts.only || opts.only.includes(t.id)));
  const { llm, model, client } = needsModel ? modelFromEnv() : { llm: null, model: { name: "(none: static only)", routerHost: "-" } };
  const judge = needsModel && opts.judge ? judgeFromEnv(client, model.name) : null;
  const scorecard = await crashTest(opts.url, {
    llm,
    model,
    judge,
    runs: opts.runs,
    only: opts.only,
    cache: opts.cache ? fileCache(path.resolve(".crash-test-cache")) : null,
    onProgress: (e) => {
      if (!opts.json && e.type === "judge") process.stderr.write(`  ${e.test}: unclear, asking the judge\n`);
      if (!opts.json && e.type === "result") process.stderr.write(`  ${e.test} run ${e.index}: ${e.verdict}\n`);
    },
  });
  if (opts.json) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    console.log(`\n${scorecard.target.network_url}\nmodel ${model.name} via ${model.routerHost} · ${opts.runs} runs per test${judge ? ` · judge ${judge.model.name}` : ""}${scorecard.cached ? " · cached" : ""}\n`);
    for (const t of scorecard.tests) {
      console.log(`${ICON[t.verdict] ?? t.verdict}  ${t.title}  (${Math.round(t.pass_rate * 100)}%)`);
      const shown = t.runs.find((r) => r.verdict !== "pass") ?? t.runs[0];
      if (shown) console.log(`       ${shown.evidence}`);
      if (shown?.judged_by) console.log(`       Judged by ${shown.judged_by}: ${shown.judge_reason ?? shown.judge_error}`);
    }
    const s = scorecard.summary;
    console.log(`\nScore ${s.score}/100 · ${s.passed} pass, ${s.flaky} flaky, ${s.failed} fail, ${s.inconclusive} inconclusive`);
  }
  if (opts.attest) {
    const key = await signingKeyFromEnv();
    const { jws, statement } = await attest(scorecard, key);
    await writeFile(opts.attest, `${jws}\n`);
    process.stderr.write(`\nAttestation written to ${opts.attest}: ${statement.sub} (sha256 ${statement.network_sha256.slice(0, 12)}…) `
      + `score ${statement.score} on ${statement.model.name}, valid until ${statement.exp}\n`);
  }
  if (upload) {
    const r = await uploadScorecard(scorecard, { source: "cli", ...upload });
    process.stderr.write(`\nUploaded run ${r.id.slice(0, 12)}… (${r.created ? "new" : "already stored"}).\n`);
  }
  process.exit(scorecard.summary.failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`crash-test: ${error.message}`);
  process.exit(2);
});
