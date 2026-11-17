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
import { modelFromEnv } from "../src/model.js";
import { crashTest } from "../src/run.js";

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
export function badgeSvg(score, model) {
  const color = score >= 85 ? "#3ddc97" : score >= 65 ? "#f5b942" : "#ff5c7a";
  const left = "crash-test";
  const right = `${score} · ${model.split("/").pop()}`;
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

const { llm, model } = modelFromEnv();
const key = await signingKeyFromEnv();
const scorecard = await crashTest(url, {
  llm,
  model,
  runs,
  cache: fileCache(path.resolve(".crash-test-cache")),
  onProgress: (e) => { if (e.type === "result") process.stderr.write(`  ${e.test} ${e.index}: ${e.verdict}\n`); },
});
const { jws, statement } = await attest(scorecard, key);

const name = `${slug(url)}-${statement.network_sha256.slice(0, 12)}`;
await mkdir(path.join(SITE, "attestations"), { recursive: true });
await mkdir(path.join(SITE, "badges"), { recursive: true });
await writeFile(path.join(SITE, "attestations", `${name}.jws`), `${jws}\n`);
await writeFile(path.join(SITE, "attestations", `${name}.scorecard.json`), `${JSON.stringify(scorecard, null, 2)}\n`);
await writeFile(path.join(SITE, "badges", `${slug(url)}.svg`), badgeSvg(statement.score, statement.model.name));

const indexPath = path.join(SITE, "attestations", "index.json");
const index = JSON.parse(await readFile(indexPath, "utf8").catch(() => '{"attestations":[]}'));
index.attestations = (index.attestations || []).filter((a) => a.sub !== statement.sub);
index.attestations.push({
  sub: statement.sub,
  network_sha256: statement.network_sha256,
  score: statement.score,
  model: statement.model.name,
  iat: statement.iat,
  exp: statement.exp,
  jws: `attestations/${name}.jws`,
  scorecard: `attestations/${name}.scorecard.json`,
  badge: `badges/${slug(url)}.svg`,
});
index.attestations.sort((a, b) => a.sub.localeCompare(b.sub));
await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
console.log(`Published ${statement.sub}: score ${statement.score} on ${statement.model.name}, valid until ${statement.exp}.\nNow deploy: cd worker && npx wrangler deploy`);
