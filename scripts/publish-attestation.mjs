// Run the full crash-test on a network, sign the result with the tester key, and publish it
// into the tester site (site/attestations, site/badges). Then deploy the site.
//
//   node --env-file=.env scripts/publish-attestation.mjs <network-url> [--runs 3]
//
// Needs CRASHTEST_API_KEY (model), CRASHTEST_SIGNING_KEY and CRASHTEST_ORIGIN (identity).
// The private key never leaves this machine; only the JWS is published.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { attest, signingKeyFromEnv } from "../src/attest.js";
import { fileCache } from "../src/file-cache.js";
import { judgesFromEnv, modelFromEnv } from "../src/model.js";
import { crashTest } from "../src/run.js";
import { uploadFromEnv, uploadScorecard } from "../src/upload.js";

const url = process.argv[2];
const runsIdx = process.argv.indexOf("--runs");
const runs = runsIdx > 0 ? Number(process.argv[runsIdx + 1]) : 3;
if (!url) {
  console.error("Usage: node --env-file=.env scripts/publish-attestation.mjs <network-url> [--runs 3]");
  process.exit(2);
}

const SITE = path.resolve("site");
const slug = (u) => {
  const x = new URL(u);
  return `${x.host}${x.pathname}`.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
};

/** A small shields-style SVG badge. */
export function badgeSvg(score, model, coverage = 100) {
  const color = score >= 85 ? "#3ddc97" : score >= 65 ? "#f5b942" : "#ff5c7a";
  const left = "crash-test";
  // Coverage is shown only when some runs were undecided (the score covers decided runs).
  const right = `${score}${coverage < 100 ? ` (${coverage}% cov)` : ""} · ${model.split("/").pop()}`;
  const lw = 8 + left.length * 7;
  const rw = 10 + right.length * 7;
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}">`
    + `<title>${esc(left)}: ${esc(right)}</title>`
    + `<rect width="${lw}" height="20" rx="3" fill="#161b22"/><rect x="${lw}" width="${rw}" height="20" rx="3" fill="${color}"/>`
    + `<rect x="${lw}" width="4" height="20" fill="${color}"/>`
    + `<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11"><text x="6" y="14" fill="#eaf5ef">${esc(left)}</text>`
    + `<text x="${lw + 6}" y="14" fill="#05100c" font-weight="bold">${esc(right)}</text></g></svg>\n`;
}

const { llm, model, client } = modelFromEnv();
// The judge panel grades only runs the checks cannot decide; the attestation records the
// judges and the judge prompt hash, so the judged part of the score is auditable.
const judges = judgesFromEnv(client, model.name);
const key = await signingKeyFromEnv();
const scorecard = await crashTest(url, {
  llm,
  model,
  judges,
  runs,
  cache: fileCache(path.resolve(".crash-test-cache")),
  onProgress: (e) => { if (e.type === "result") process.stderr.write(`  ${e.test} ${e.index}: ${e.verdict}\n`); },
});
const name = `${slug(url)}-${scorecard.target.network_sha256.slice(0, 12)}`;
const scorecardPath = `attestations/${name}.scorecard.json`;
// in-toto Statement v1 + Test Result predicate, in a DSSE envelope (.intoto.json).
const { envelope, statement } = await attest(scorecard, { ...key, url: `${new URL(key.issuer).origin}/${scorecardPath}` });

await mkdir(path.join(SITE, "attestations"), { recursive: true });
await mkdir(path.join(SITE, "badges"), { recursive: true });
await writeFile(path.join(SITE, "attestations", `${name}.intoto.json`), `${JSON.stringify(envelope, null, 2)}\n`);
await writeFile(path.join(SITE, "attestations", `${name}.scorecard.json`), `${JSON.stringify(scorecard, null, 2)}\n`);
await writeFile(path.join(SITE, "badges", `${slug(url)}.svg`), badgeSvg(statement.score, statement.model.name, statement.coverage));

const indexPath = path.join(SITE, "attestations", "index.json");
const index = JSON.parse(await readFile(indexPath, "utf8").catch(() => '{"attestations":[]}'));
index.attestations = (index.attestations || []).filter((a) => a.sub !== statement.sub);
index.attestations.push({
  sub: statement.sub,
  network_sha256: statement.network_sha256,
  score: statement.score,
  coverage: statement.coverage,
  model: statement.model.name,
  iat: statement.iat,
  exp: statement.exp,
  format: "in-toto",
  attestation: `attestations/${name}.intoto.json`,
  scorecard: scorecardPath,
  badge: `badges/${slug(url)}.svg`,
});
index.attestations.sort((a, b) => a.sub.localeCompare(b.sub));
await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
// With INGEST_TOKEN set, the attested scorecard also goes into the results database.
const upload = uploadFromEnv();
if (upload) {
  const u = await uploadScorecard(scorecard, { source: "attestation", ...upload });
  console.log(`Uploaded run ${u.id.slice(0, 12)} (${u.created ? "new" : "already stored"}).`);
}
console.log(`Published ${statement.sub}: score ${statement.score} on ${statement.model.name}, valid until ${statement.exp}.\nNow deploy: cd worker && npx wrangler deploy`);
