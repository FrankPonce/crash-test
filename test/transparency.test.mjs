// Logging published attestations: the log is chosen explicitly (public, permanent), and an
// entry that doesn't verify is never recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REKOR } from "agent-trust-kit/rekor";
import { newSiteKey } from "agent-trust-kit/keys";
import { signEnvelope } from "agent-trust-kit/dsse";
import { logAttestation, rekorUrlOf } from "../src/transparency.js";

test("the log must be chosen: staging, production or a URL; no default", () => {
  assert.equal(rekorUrlOf("staging"), REKOR.staging);
  assert.equal(rekorUrlOf("production"), REKOR.production);
  assert.equal(rekorUrlOf("https://rekor.example/x"), "https://rekor.example");
  assert.throws(() => rekorUrlOf(null), /Choose a log/);
});

test("an entry that does not verify against the envelope is refused, and nothing is written", async () => {
  const site = await mkdtemp(path.join(tmpdir(), "ct-log-"));
  await mkdir(path.join(site, "attestations"));
  const key = await newSiteKey();
  const envelope = await signEnvelope('{"_type":"https://in-toto.io/Statement/v1"}', "application/vnd.in-toto+json", key.privateJwk);
  await writeFile(path.join(site, "attestations", "x.intoto.json"), JSON.stringify(envelope));
  // A log that answers with an entry for something else.
  const bogus = { abc: { body: btoa('{"kind":"dsse","spec":{"payloadHash":{"value":"00"}}}'), integratedTime: 1, logID: "l", logIndex: 1, verification: { inclusionProof: { logIndex: 0, treeSize: 1, rootHash: "00", hashes: [], checkpoint: "" } } } };
  const fetchImpl = async () => new Response(JSON.stringify(bogus), { status: 201 });
  await assert.rejects(logAttestation(site, { sub: "s", attestation: "attestations/x.intoto.json" }, key.publicJwk, REKOR.staging, { fetchImpl }), /did not verify: .*different payload/);
  await assert.rejects(readFile(path.join(site, "attestations", "x.rekor.json")), /ENOENT/);
});
