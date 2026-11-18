// Turn a scorecard into a signed attestation: an in-toto Statement v1 with the Test Result
// predicate, in a DSSE envelope (agent-trust-kit). The tester's private key is a server
// secret; its public key directory must be served at
// <CRASHTEST_ORIGIN>/.well-known/http-message-signatures-directory for anyone to verify.

import { readFile } from "node:fs/promises";
import { attestationFromScorecard, attestationSummary, signAttestation } from "agent-trust-kit";
import { MIN_COVERAGE } from "./run.js";

/**
 * Sign a scorecard as an attestation.
 *
 * Only complete, clean runs are attested: the network must have loaded and passed static
 * validity, no run may have hit a provider error, and at least MIN_COVERAGE percent of
 * the applicable runs must have been decided.
 *
 * :param scorecard: A crash-test/scorecard@1 object.
 * :param opts: {issuer: the tester origin, privateJwk, ttlDays, now, url: where the full
 *     scorecard is published (optional)}.
 * :return: {envelope: the DSSE envelope, intoto: the in-toto statement, statement: its flat
 *     summary (score, coverage, model, iat, exp, ...)}.
 * :raises Error: When the scorecard should not be attested.
 */
export async function attest(scorecard, { issuer, privateJwk, ttlDays = 30, now = Date.now(), url = null }) {
  const staticTest = scorecard.tests.find((t) => t.id === "static_validity");
  if (!scorecard.target?.network_sha256 || staticTest?.verdict !== "pass") throw new Error("Not attesting: the network did not load and validate.");
  if (scorecard.summary?.errors) throw new Error(`Not attesting: ${scorecard.summary.errors} runs hit provider errors. Run again.`);
  const coverage = scorecard.summary?.coverage;
  if (!Number.isFinite(coverage)) throw new Error("Not attesting: the scorecard has no coverage (made before scoring decided/1). Run again.");
  if (coverage < MIN_COVERAGE) throw new Error(`Not attesting: only ${coverage}% of applicable runs were decided (minimum ${MIN_COVERAGE}%). The score would rest on too few runs.`);
  // The statement records coverage and scoring (the score covers decided runs only), the
  // judges, the judge prompt's digest and judged runs per test, so the judged part is auditable.
  const intoto = attestationFromScorecard(scorecard, { issuer, now, ttlDays, url });
  return { envelope: await signAttestation(intoto, privateJwk), intoto, statement: attestationSummary(intoto) };
}

/** Read the tester's signing key from CRASHTEST_SIGNING_KEY (a path to a private JWK file). */
export async function signingKeyFromEnv(env = process.env) {
  if (!env.CRASHTEST_SIGNING_KEY || !env.CRASHTEST_ORIGIN) {
    throw new Error("Set CRASHTEST_SIGNING_KEY (path to the tester's private JWK) and CRASHTEST_ORIGIN (where its key directory is served).");
  }
  return { privateJwk: JSON.parse(await readFile(env.CRASHTEST_SIGNING_KEY, "utf8")), issuer: env.CRASHTEST_ORIGIN };
}
