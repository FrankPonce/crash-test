// Put published attestations on the public transparency log (Sigstore Rekor).
//
//   node --env-file=.env scripts/log-attestations.mjs --rekor staging      # public test log
//   node --env-file=.env scripts/log-attestations.mjs --rekor production   # permanent
//   ... --sub <network URL>   only that network's attestation
//
// Logs every in-toto attestation in site/attestations/index.json that isn't on that log yet,
// verifies each entry offline, writes <name>.rekor.json and the index's `log` field. Uses the
// tester's public key only (the envelope is already signed); then deploy the tester.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { publicPart } from "agent-trust-kit/keys";
import { signingKeyFromEnv } from "../src/attest.js";
import { logAttestation, rekorUrlOf } from "../src/transparency.js";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const rekorUrl = rekorUrlOf(arg("--rekor"));
const only = arg("--sub");
const SITE = path.resolve("site");
const indexPath = path.join(SITE, "attestations", "index.json");
const index = JSON.parse(await readFile(indexPath, "utf8"));
const { privateJwk } = await signingKeyFromEnv();
const publicJwk = await publicPart(privateJwk);

let changed = 0;
for (const entry of index.attestations) {
  if (only && entry.sub !== only) continue;
  if (!entry.attestation) { console.log(`skip ${entry.sub}: not an in-toto attestation`); continue; }
  if (entry.log?.url === rekorUrl) { console.log(`already logged ${entry.sub}: #${entry.log.logIndex}`); continue; }
  entry.log = await logAttestation(SITE, entry, publicJwk, rekorUrl);
  changed++;
  console.log(`logged ${entry.sub}: ${rekorUrl} #${entry.log.logIndex} at ${entry.log.integratedTime}`);
}
if (changed) {
  await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`${changed} logged. Now: npm run build:site && cd worker && npx wrangler deploy`);
}
