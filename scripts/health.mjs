#!/usr/bin/env node
// Check the project's live pieces (same checks as https://crashtest.frankmp12357.workers.dev/health)
// and exit 1 when anything is down, invalid, or an attestation expires within 7 days.
// Writes a table to $GITHUB_STEP_SUMMARY when set. No secrets needed.
//
//   node scripts/health.mjs [--json]

import { appendFile } from "node:fs/promises";
import { healthReport } from "../worker/src/health.js";

const report = await healthReport();
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));

const mark = { ok: "✅", warn: "⚠️", fail: "❌", expected: "☑️" };
const lines = [`## Health: ${mark[report.status]} ${report.status} (${report.generated_at})`, "", "| | Piece | Check | Detail |", "|---|---|---|---|"];
for (const g of report.groups) {
  for (const c of g.checks) lines.push(`| ${mark[c.status]} | ${g.name} | ${c.label} | ${String(c.detail).replace(/\|/g, "\\|")} |`);
}
const table = lines.join("\n");
if (!process.argv.includes("--json")) console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${table}\n`);

const problems = report.groups.flatMap((g) => g.checks.filter((c) => c.status === "fail" || c.status === "warn").map((c) => `${g.name}: ${c.label}: ${c.detail}`));
for (const p of problems) console.error(process.env.GITHUB_ACTIONS ? `::error::${p}` : `PROBLEM ${p}`);
process.exit(problems.length ? 1 : 0);
