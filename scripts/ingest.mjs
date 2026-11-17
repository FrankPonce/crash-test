// Backfill the results database from scorecards on disk.
//
//   node --env-file=.env scripts/ingest.mjs [--dry-run] [files or folders...]
//
// Default: results/*.json (not results/archive/, which holds superseded and outage runs)
// as source "backfill", and site/attestations/*.scorecard.json as source "attestation".
// Files that are not valid scorecards are skipped with a reason. Uploads are idempotent,
// so running this twice stores nothing new.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { validateScorecard } from "../worker/src/results.js";
import { uploadFromEnv, uploadScorecard } from "../src/upload.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targets = args.filter((a) => !a.startsWith("--"));

async function jsonFiles(p) {
  const s = await stat(p);
  if (!s.isDirectory()) return [p];
  return (await readdir(p)).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(p, f));
}

const sourceFor = (file) => (file.endsWith(".scorecard.json") ? "attestation" : "backfill");
const files = targets.length
  ? (await Promise.all(targets.map(jsonFiles))).flat()
  : [...await jsonFiles("results"), ...(await jsonFiles(path.join("site", "attestations"))).filter((f) => f.endsWith(".scorecard.json"))];

const upload = dryRun ? null : uploadFromEnv();
if (!dryRun && !upload) throw new Error("Set INGEST_TOKEN (or use --dry-run).");

const tally = { new: 0, stored: 0, skipped: 0, failed: 0 };
for (const file of files) {
  let card;
  try {
    card = JSON.parse(await readFile(file, "utf8"));
  } catch {
    console.log(`skip  ${file}: not JSON`);
    tally.skipped++;
    continue;
  }
  const check = validateScorecard(card);
  if (!check.ok) {
    console.log(`skip  ${file}: ${check.reason}`);
    tally.skipped++;
    continue;
  }
  if (dryRun) {
    console.log(`ok    ${file} (${sourceFor(file)})`);
    tally.new++;
    continue;
  }
  try {
    const r = await uploadScorecard(card, { source: sourceFor(file), ...upload });
    console.log(`${r.created ? "new  " : "had  "} ${file} → ${r.id.slice(0, 12)}`);
    tally[r.created ? "new" : "stored"]++;
  } catch (error) {
    console.log(`FAIL  ${file}: ${error.message}`);
    tally.failed++;
  }
}
console.log(`\n${dryRun ? "valid" : "new"} ${tally.new}, already stored ${tally.stored}, skipped ${tally.skipped}, failed ${tally.failed}`);
process.exit(tally.failed ? 1 : 0);
