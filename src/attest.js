// Turn a scorecard into a signed attestation (agent-trust-kit format).
// The tester's private key is a server secret; its public key directory must be served
// at <CRASHTEST_ORIGIN>/.well-known/http-message-signatures-directory for anyone to verify.

import { readFile } from "node:fs/promises";
import { attestationFromScorecard, signAttestation } from "agent-trust-kit";

/**
 * Sign a scorecard as an attestation.
 *
 * Only complete, clean runs are attested: the network must have loaded and passed static
 * validity, and no run may have hit a provider error.
 *
 * :param scorecard: A crash-test/scorecard@1 object.
 * :param opts: {issuer: the tester origin, privateJwk, ttlDays, now}.
 * :return: {jws, statement}.
 * :raises Error: When the scorecard should not be attested.
 */
export async function attest(scorecard, { issuer, privateJwk, ttlDays = 30, now = Date.now() }) {
  const staticTest = scorecard.tests.find((t) => t.id === "static_validity");
  if (!scorecard.target?.network_sha256 || staticTest?.verdict !== "pass") throw new Error("Not attesting: the network did not load and validate.");
  if (scorecard.summary?.errors) throw new Error(`Not attesting: ${scorecard.summary.errors} runs hit provider errors. Run again.`);
  const statement = attestationFromScorecard(scorecard, { issuer, now, ttlDays });
  // Say which part of the score a judge panel decided, and with which models and prompt,
  // so the signed claim separates deterministic verdicts from judged ones.
  statement.judges = (scorecard.judges || []).map((j) => j.name);
  statement.judge_prompt_sha256 = scorecard.judge_prompt_sha256 ?? null;
  for (const t of scorecard.tests || []) {
    const judged = (t.runs || []).filter((r) => r.deterministic_verdict === "inconclusive").length;
    if (judged && statement.results[t.id]) statement.results[t.id].judged_runs = judged;
  }
  return { jws: await signAttestation(statement, privateJwk), statement };
}

/** Read the tester's signing key from CRASHTEST_SIGNING_KEY (a path to a private JWK file). */
export async function signingKeyFromEnv(env = process.env) {
  if (!env.CRASHTEST_SIGNING_KEY || !env.CRASHTEST_ORIGIN) {
    throw new Error("Set CRASHTEST_SIGNING_KEY (path to the tester's private JWK) and CRASHTEST_ORIGIN (where its key directory is served).");
  }
  return { privateJwk: JSON.parse(await readFile(env.CRASHTEST_SIGNING_KEY, "utf8")), issuer: env.CRASHTEST_ORIGIN };
}
