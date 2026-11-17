// Run every model against every network and write results/<date>-matrix.md.
// Usage: node --env-file=.env scripts/matrix.mjs [--runs 3] [--models a,b] [--sites url,url] [--only id,id]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { LlmClient } from "../vendor/runtime/llm.js";
import { fixedModel } from "../src/model.js";
import { crashTest } from "../src/run.js";
import { fileCache } from "../src/file-cache.js";

const DEFAULT_MODELS = ["alibaba/qwen3.8-flash", "deepseek/deepseek-v4.1-flash", "mistralai/ministral-3-8b", "meta/llama-3.1-8b-instruct"];
const DEFAULT_SITES = [
  "https://charge.frankmp12357.workers.dev/charge_planner",
  "https://sketchy.frankmp12357.workers.dev/spot_deals",
];

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const runs = Number(arg("runs", 3));
const models = arg("models", DEFAULT_MODELS.join(",")).split(",");
const sites = arg("sites", DEFAULT_SITES.join(",")).split(",");
const only = arg("only", "") ? arg("only").split(",") : null;

const baseUrl = (process.env.CRASHTEST_ROUTER || "https://api.otari.ai/api/v1").replace(/\/$/, "");
if (!process.env.CRASHTEST_API_KEY) throw new Error("Set CRASHTEST_API_KEY in .env");
const client = new LlmClient({ baseUrl, apiKey: process.env.CRASHTEST_API_KEY });
const day = new Date().toISOString().slice(0, 10);
const outDir = path.resolve("results");
await mkdir(outDir, { recursive: true });

const rows = [];
for (const model of models) {
  for (const site of sites) {
    const siteName = site.split("/").pop();
    process.stderr.write(`\n== ${siteName} × ${model}\n`);
    try {
      const card = await crashTest(site, {
        llm: fixedModel(client, model),
        model: { name: model, routerHost: new URL(baseUrl).host },
        runs,
        only,
        cache: fileCache(path.resolve(".crash-test-cache")),
        onProgress: (e) => { if (e.type === "result") process.stderr.write(`  ${e.test} ${e.index}: ${e.verdict}\n`); },
      });
      await writeFile(path.join(outDir, `${day}-${siteName}-${model.replace(/[^\w.-]+/g, "_")}.json`), JSON.stringify(card, null, 2));
      rows.push({ model, site: siteName, card });
    } catch (error) {
      process.stderr.write(`  ERROR: ${error.message}\n`);
      rows.push({ model, site: siteName, error: error.message });
    }
  }
}

// Markdown summary from every result file of the day, so partial re-runs merge in.
const { readdir, readFile } = await import("node:fs/promises");
rows.length = 0;
for (const f of (await readdir(outDir)).filter((f) => f.startsWith(day) && f.endsWith(".json")).sort()) {
  const card = JSON.parse(await readFile(path.join(outDir, f), "utf8"));
  if (card.schema !== "crash-test/scorecard@1" || !card.model?.name || card.tester?.test_version !== (await import("../src/tests/index.js")).TEST_VERSION) continue;
  rows.push({ model: card.model.name, site: card.target.network_url.split("/").pop(), card });
}
rows.sort((a, b) => a.model.localeCompare(b.model) || a.site.localeCompare(b.site));
// One row per (model, site), one column per test, passes/applicable runs.
const testIds = rows.find((r) => r.card)?.card.tests.map((t) => t.id) ?? [];
const cell = (t) => (t.verdict === "skipped" ? "skip" : t.verdict === "not_applicable" ? "n/a" : t.verdict === "error" ? "err" : `${t.runs.filter((x) => x.verdict === "pass").length}/${t.runs.filter((x) => !["not_applicable", "error"].includes(x.verdict)).length}${t.verdict === "pass" ? "" : t.verdict === "fail" ? " ❌" : " ⚠️"}`);
let md = `# Crash-test matrix, ${day}\n\n${runs} runs per model test. Router: ${new URL(baseUrl).host}. Cells: passes/applicable runs; ❌ fail, ⚠️ flaky or inconclusive; n/a = correctly declined, so not reached.\n\n`;
md += `| Model | Site | Score | ${testIds.join(" | ")} |\n|---|---|---|${testIds.map(() => "---").join("|")}|\n`;
for (const r of rows) {
  if (r.error) { md += `| ${r.model} | ${r.site} | error | ${r.error.slice(0, 80)} |\n`; continue; }
  md += `| ${r.model} | ${r.site} | ${r.card.summary.score}${r.card.summary.errors ? ` (${r.card.summary.errors} err)` : ""} | ${r.card.tests.map(cell).join(" | ")} |\n`;
}
await writeFile(path.join(outDir, `${day}-matrix.md`), md);
console.log(md);
