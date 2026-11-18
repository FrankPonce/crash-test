// CI regression watch: re-test the networks in watch.json when they changed or got stale,
// store the runs in the results database, and fail on regressions.
//
//   node --env-file-if-exists=.env scripts/ci-watch.mjs [--dry-run] [--config watch.json]
//
// Env: CRASHTEST_API_KEY (model; not needed for --dry-run), CRASHTEST_ROUTER,
//      CRASHTEST_JUDGE_MODELS, INGEST_TOKEN (upload; without it runs aren't stored),
//      CRASHTEST_API (results API base, default the public tester's /api),
//      GITHUB_STEP_SUMMARY (set by GitHub Actions).
// Exit: 0 fine, 1 a regression, 2 some pair could not run (network down, router refused).
import { appendFile, readFile } from "node:fs/promises";
import { LlmClient } from "../vendor/runtime/llm.js";
import { loadTarget } from "../src/load.js";
import { fixedModel, judgesFromEnv, DEFAULT_ROUTER } from "../src/model.js";
import { crashTest } from "../src/run.js";
import { TEST_VERSION } from "../src/tests/index.js";
import { uploadFromEnv, uploadScorecard } from "../src/upload.js";
import { readWatchConfig, runWatch, watchSummary } from "../src/watch.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const configPath = args.includes("--config") ? args[args.indexOf("--config") + 1] : "watch.json";
const apiBase = (process.env.CRASHTEST_API || "https://crashtest.frankmp12357.workers.dev/api").replace(/\/$/, "");
const config = readWatchConfig(JSON.parse(await readFile(configPath, "utf8")));

const getJson = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  return res.json();
};

let client = null;
if (!dryRun) {
  if (!process.env.CRASHTEST_API_KEY) throw new Error("Set CRASHTEST_API_KEY (or use --dry-run).");
  client = new LlmClient({ baseUrl: (process.env.CRASHTEST_ROUTER || DEFAULT_ROUTER).replace(/\/$/, ""), apiKey: process.env.CRASHTEST_API_KEY });
}
const upload = uploadFromEnv();
if (!dryRun && !upload) console.warn("INGEST_TOKEN is not set: runs will not be stored, so the next watch re-tests them.");

const report = await runWatch(config, {
  testVersion: TEST_VERSION,
  now: Date.now(),
  dryRun,
  log: (t) => console.error(t),
  liveHash: async (url) => (await loadTarget(url)).target?.sha256 ?? null,
  latest: async (url, model) => {
    const { runs } = await getJson(`${apiBase}/runs?network_url=${encodeURIComponent(url)}&model=${encodeURIComponent(model)}&limit=1`);
    return runs.length ? getJson(`${apiBase}/runs/${runs[0].id}`) : null;
  },
  crashTest: (url, model, runs) => crashTest(url, {
    llm: fixedModel(client, model),
    model: { name: model, routerHost: new URL(client.baseUrl).host },
    judges: judgesFromEnv(client, model),
    runs,
    onProgress: (e) => { if (e.type === "result") console.error(`  ${e.test} ${e.index}: ${e.verdict}`); },
  }),
  upload: upload ? (card) => uploadScorecard(card, { source: "ci", ...upload }) : null,
});

const md = watchSummary(report, { apiBase });
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
process.exit(report.regressed ? 1 : report.failed ? 2 : 0);
