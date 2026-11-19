// Public transparency log for published attestations (Sigstore Rekor, via agent-trust-kit).
// Each logged attestation gets <name>.rekor.json next to its envelope and a `log` field in
// attestations/index.json, so anyone can check, offline, that the tester published exactly
// this envelope at that time and can't quietly swap or withdraw it.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { REKOR, logEnvelope, verifyLogEntry } from "agent-trust-kit/rekor";

/** "staging" | "production" | a Rekor URL → the URL. No default: logging is public. */
export function rekorUrlOf(choice) {
  if (!choice) throw new Error('Choose a log: --rekor staging (public test log) or --rekor production (permanent).');
  return REKOR[choice] ?? new URL(choice).origin;
}

/**
 * Log one index entry's envelope and record where.
 *
 * :param site: The tester site folder (holds attestations/).
 * :param entry: An attestations/index.json entry with an in-toto `attestation` file.
 * :param publicJwk: The tester's public signing key (the envelope's signer).
 * :param rekorUrl: Which Rekor to log to.
 * :return: The index entry's new `log` field.
 */
export async function logAttestation(site, entry, publicJwk, rekorUrl, { fetchImpl } = {}) {
  if (!entry.attestation) throw new Error(`${entry.sub}: only in-toto (DSSE) attestations can be logged.`);
  const envelope = JSON.parse(await readFile(path.join(site, entry.attestation), "utf8"));
  const logged = await logEnvelope(envelope, publicJwk, { rekorUrl, ...(fetchImpl ? { fetchImpl } : {}) });
  const check = await verifyLogEntry(envelope, logged, { signerJwk: publicJwk });
  if (!check.ok) throw new Error(`${entry.sub}: the log entry did not verify: ${check.reason}`);
  const file = entry.attestation.replace(/\.intoto\.json$/, ".rekor.json");
  await writeFile(path.join(site, file), `${JSON.stringify(logged, null, 2)}\n`);
  return { url: logged.log, logIndex: logged.logIndex, uuid: logged.uuid, integratedTime: check.integratedTime, entry: file };
}
