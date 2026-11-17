// Upload a scorecard to the results database (POST /api/results on the tester Worker).
//
// INGEST_TOKEN       Bearer token for uploads (a Worker secret; never logged)
// CRASHTEST_RESULTS  Upload URL (default: the public tester's /api/results)

export const DEFAULT_RESULTS_URL = "https://crashtest.frankmp12357.workers.dev/api/results";

/**
 * Upload one scorecard.
 *
 * :param scorecard: The scorecard object.
 * :param opts: {source, token, url, fetchImpl}.
 * :return: {id, created}.
 * :raises Error: When there is no token or the server refuses the upload.
 */
export async function uploadScorecard(scorecard, { source, token, url = DEFAULT_RESULTS_URL, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error("Set INGEST_TOKEN to upload results.");
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ source, scorecard }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Upload refused (HTTP ${res.status}): ${body?.error?.message ?? "no details"}`);
  return body;
}

/**
 * Upload settings from the environment, or null when uploads are not configured.
 *
 * :param env: The environment.
 * :return: {token, url} or null.
 */
export function uploadFromEnv(env = process.env) {
  return env.INGEST_TOKEN ? { token: env.INGEST_TOKEN, url: env.CRASHTEST_RESULTS || DEFAULT_RESULTS_URL } : null;
}
