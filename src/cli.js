#!/usr/bin/env node
// crash-test <network-url> [--runs 3] [--only id,id] [--json] [--no-cache]

import path from "node:path";
import { crashTest } from "./run.js";
import { modelFromEnv } from "./model.js";
import { TESTS } from "./tests/index.js";

const ICON = { pass: "PASS ", fail: "FAIL ", flaky: "FLAKY", inconclusive: "?    ", skipped: "SKIP " };

function parseArgs(argv) {
  const opts = { runs: 3, json: false, cache: true, only: null, url: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--runs") opts.runs = Math.max(1, Math.min(10, Number(argv[++i]) || 3));
    else if (a === "--only") opts.only = String(argv[++i] || "").split(",").filter(Boolean);
    else if (a === "--json") opts.json = true;
    else if (a === "--no-cache") opts.cache = false;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (!opts.url) opts.url = a;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.url) {
    console.log("Usage: crash-test <network-url> [--runs 3] [--only static_validity,out_of_scope] [--json] [--no-cache]\n"
      + "Model: CRASHTEST_API_KEY, CRASHTEST_ROUTER (default hosted Otari), CRASHTEST_MODEL.");
    process.exit(opts.url ? 0 : 2);
  }
  const needsModel = TESTS.some((t) => t.usesModel && (!opts.only || opts.only.includes(t.id)));
  const { llm, model } = needsModel ? modelFromEnv() : { llm: null, model: { name: "(none: static only)", routerHost: "-" } };
  const scorecard = await crashTest(opts.url, {
    llm,
    model,
    runs: opts.runs,
    only: opts.only,
    cacheDir: opts.cache ? path.resolve(".crash-test-cache") : null,
    onProgress: (e) => {
      if (!opts.json && e.type === "result") process.stderr.write(`  ${e.test} run ${e.index}: ${e.verdict}\n`);
    },
  });
  if (opts.json) {
    console.log(JSON.stringify(scorecard, null, 2));
  } else {
    console.log(`\n${scorecard.target.network_url}\nmodel ${model.name} via ${model.routerHost} · ${opts.runs} runs per test${scorecard.cached ? " · cached" : ""}\n`);
    for (const t of scorecard.tests) {
      console.log(`${ICON[t.verdict] ?? t.verdict}  ${t.title}  (${Math.round(t.pass_rate * 100)}%)`);
      const shown = t.runs.find((r) => r.verdict !== "pass") ?? t.runs[0];
      if (shown) console.log(`       ${shown.evidence}`);
    }
    const s = scorecard.summary;
    console.log(`\nScore ${s.score}/100 · ${s.passed} pass, ${s.flaky} flaky, ${s.failed} fail, ${s.inconclusive} inconclusive`);
  }
  process.exit(scorecard.summary.failed ? 1 : 0);
}

main().catch((error) => {
  console.error(`crash-test: ${error.message}`);
  process.exit(2);
});
