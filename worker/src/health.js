// Health of the project's own live pieces: every site, MCP server, network signature and
// attestation, checked live with the same code that admits callers (agent-trust-kit
// checkNetwork). Used by GET /api/health (the /health page) and by scripts/health.mjs (CI).
// No model is involved, and nothing here writes anywhere.
//
// Each check: {id, label, status: "ok" | "warn" | "fail" | "expected", detail, evidence?}.
// "expected" is an intended failure: the bad fixture (Spot Deals) must stay unsigned and
// refused; if it ever passed, that would be the failure.

import { checkNetwork } from "agent-trust-kit/peer";

export const TESTER = "https://crashtest.frankmp12357.workers.dev";
export const EXPIRY_WARN_DAYS = 7;

export const SITES = [
  {
    id: "charge", name: "Charge", role: "The submission: plans EV charging from real spot prices",
    origin: "https://charge.frankmp12357.workers.dev", network: "charge_planner", expect: "trusted",
    extras: ["default_model", "peer_trust"],
  },
  {
    id: "taloyhtio", name: "As Oy Koivurinne", role: "Simulated housing company and its charging arbiter",
    origin: "https://taloyhtio.frankmp12357.workers.dev", network: "koivurinne_charging", expect: "trusted",
    extras: ["default_model", "peer_trust", "arbiter_mcp"],
  },
  {
    id: "sketchy", name: "Spot Deals", role: "Deliberately badly instructed test fixture",
    origin: "https://sketchy.frankmp12357.workers.dev", network: "spot_deals", expect: "refused",
    extras: [],
  },
];

const DAY = 864e5;
const ok = (id, label, detail, evidence) => ({ id, label, status: "ok", detail, ...(evidence ? { evidence } : {}) });
const warn = (id, label, detail, evidence) => ({ id, label, status: "warn", detail, ...(evidence ? { evidence } : {}) });
const bad = (id, label, detail, evidence) => ({ id, label, status: "fail", detail, ...(evidence ? { evidence } : {}) });
const expected = (id, label, detail, evidence) => ({ id, label, status: "expected", detail, ...(evidence ? { evidence } : {}) });

async function timed(fetchImpl, url, init = {}) {
  return fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(8000) });
}

async function mcpCall(fetchImpl, url, method, params = {}) {
  const resp = await timed(fetchImpl, url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!resp.ok) throw new Error(`answered HTTP ${resp.status}`);
  const body = await resp.json();
  if (body.error) throw new Error(body.error.message || "JSON-RPC error");
  return body.result;
}

const tryCheck = async (id, label, fn) => {
  try {
    return await fn();
  } catch (error) {
    return bad(id, label, `Could not check: ${error?.message || error}`);
  }
};

async function pageCheck(fetchImpl, origin) {
  return tryCheck("page", "Site is up", async () => {
    const resp = await timed(fetchImpl, `${origin}/`);
    const type = resp.headers.get("content-type") || "";
    return resp.ok && /html/i.test(type)
      ? ok("page", "Site is up", `${origin}/ answers ${resp.status}`, `${origin}/`)
      : bad("page", "Site is up", `${origin}/ answered ${resp.status} (${type || "no content type"})`, `${origin}/`);
  });
}

export function trustChecks(site, r, now) {
  const networkUrl = `${site.origin}/${site.network}`;
  const testerLink = `${TESTER}/?url=${encodeURIComponent(networkUrl)}`;
  const out = [];
  if (r.error) return [bad("network", "Agent network loads", r.error, `${site.origin}/agent-manifest.json`)];
  const sigUrl = `${site.origin}/${site.network}.signature.json`;
  const s = r.signature;
  if (site.expect === "refused") {
    out.push(s.ok
      ? warn("signature", "Not signed (intended)", `Unexpectedly signed by ${s.by}. The fixture is meant to be unsigned.`, sigUrl)
      : expected("signature", "Not signed (intended)", `Unsigned, as intended: ${s.reason}.`, sigUrl));
  } else {
    out.push(s.ok
      ? ok("signature", "Signed by its domain", `Signed by ${new URL(s.by).host} (key ${String(s.kid).slice(0, 10)}…); hash ${r.network_sha256.slice(0, 12)} matches what is served.`, sigUrl)
      : bad("signature", "Signed by its domain", `Signature does not hold: ${s.reason}.`, sigUrl));
  }
  const a = r.attestation;
  if (site.expect === "refused") {
    out.push(a.ok
      ? bad("attestation", "Refused by the arbiter (intended)", `The fixture now passes the trust policy (score ${a.score}). It is meant to be refused.`, testerLink)
      : expected("attestation", "Refused by the arbiter (intended)", Number.isFinite(a.score) ? `Tested ${a.score}/100, refused: ${a.reason}.` : `Refused: ${a.reason}.`, testerLink));
  } else if (a.ok) {
    const days = Math.floor((Date.parse(a.exp) - now) / DAY);
    const logged = a.log?.ok ? ` Publicly logged: Rekor${a.log.url.includes("sigstage") ? " staging" : ""} entry #${a.log.logIndex}, ${a.log.integratedTime.slice(0, 10)}.` : "";
    const detail = `Tested ${a.score}/100 (coverage ${a.coverage}%) on ${a.model}, test version ${a.test_version}; valid until ${a.exp.slice(0, 10)} (${days} days).${logged}`;
    if (a.log && !a.log.ok) out.push(warn("attestation", "Attested and admitted", `${detail} Its transparency log entry does not check out: ${a.log.reason}.`, testerLink));
    else out.push(days < EXPIRY_WARN_DAYS ? warn("attestation", "Attested and admitted", `${detail} Re-attest soon.`, testerLink) : ok("attestation", "Attested and admitted", detail, testerLink));
  } else {
    out.push(bad("attestation", "Attested and admitted", `Not vouched for: ${a.reason}.`, testerLink));
  }
  // The numbers behind the words, for the page.
  out[0].data = { signed: !!s.ok, host: s.ok ? new URL(s.by).host : null, kid: s.kid ?? null, network_sha256: r.network_sha256 ?? null };
  out[1].data = {
    vouched: !!a.ok, score: Number.isFinite(a.score) ? a.score : null, coverage: a.coverage ?? null, model: a.model ?? null,
    test_version: a.test_version ?? null, exp: a.exp ?? null, days_left: a.exp ? Math.floor((Date.parse(a.exp) - now) / DAY) : null,
    failed: a.failed || [],
    log: a.log ?? null,
  };
  return out;
}

const EXTRAS = {
  async default_model(fetchImpl, site) {
    return tryCheck("default_model", "Free default model", async () => {
      const url = `${site.origin}/api/llm/v1/models`;
      const resp = await timed(fetchImpl, url);
      if (!resp.ok) return bad("default_model", "Free default model", `${url} answered ${resp.status}.`, url);
      const n = (await resp.json())?.data?.length ?? 0;
      return n ? ok("default_model", "Free default model", `The site's own model route lists ${n} model${n === 1 ? "" : "s"} (no key needed).`, url) : bad("default_model", "Free default model", "No models listed.", url);
    });
  },
  async peer_trust(fetchImpl, site) {
    return tryCheck("peer_trust", "Consent-card partner check", async () => {
      const url = `${site.origin}/.well-known/peer-trust.json`;
      const resp = await timed(fetchImpl, url);
      if (!resp.ok) return bad("peer_trust", "Consent-card partner check", `${url} answered ${resp.status}.`, url);
      const peers = (await resp.json())?.peers || [];
      const untrusted = peers.filter((p) => !p.trusted);
      if (!peers.length) return warn("peer_trust", "Consent-card partner check", "No partners listed.", url);
      return untrusted.length
        ? warn("peer_trust", "Consent-card partner check", `Shows a warning for ${untrusted.map((p) => p.host).join(", ")}.`, url)
        : ok("peer_trust", "Consent-card partner check", `Shows ${peers.map((p) => p.host).join(", ")} as signed and tested.`, url);
    });
  },
  async arbiter_mcp(fetchImpl, site) {
    return tryCheck("arbiter_mcp", "Arbiter MCP server", async () => {
      const url = `${site.origin}/mcp`;
      const r = await mcpCall(fetchImpl, url, "tools/call", { name: "get_rules", arguments: {} });
      if (r?.isError) return bad("arbiter_mcp", "Arbiter MCP server", "get_rules returned an error.", url);
      const tools = (await mcpCall(fetchImpl, url, "tools/list"))?.tools?.map((t) => t.name) || [];
      return ok("arbiter_mcp", "Arbiter MCP server", `Answers get_rules; tools: ${tools.join(", ")}.`, url);
    });
  },
};

async function testerChecks(fetchImpl, now) {
  return Promise.all([
    pageCheck(fetchImpl, TESTER),
    tryCheck("keys", "Tester's signing keys published", async () => {
      const url = `${TESTER}/.well-known/http-message-signatures-directory`;
      const resp = await timed(fetchImpl, url);
      const n = resp.ok ? (await resp.json())?.keys?.length ?? 0 : 0;
      return n ? ok("keys", "Tester's signing keys published", `${n} key${n === 1 ? "" : "s"} in the key directory, so anyone can verify its attestations.`, url) : bad("keys", "Tester's signing keys published", `${url} answered ${resp.status} with no keys.`, url);
    }),
    tryCheck("index", "Attestation index", async () => {
      const url = `${TESTER}/attestations/index.json`;
      const resp = await timed(fetchImpl, url);
      if (!resp.ok) return bad("index", "Attestation index", `${url} answered ${resp.status}.`, url);
      const list = (await resp.json())?.attestations || [];
      const soonest = list.map((a) => a.exp).filter(Boolean).sort()[0];
      const days = soonest ? Math.floor((Date.parse(soonest) - now) / DAY) : null;
      return ok("index", "Attestation index", `${list.length} published attestation${list.length === 1 ? "" : "s"}${soonest ? `; the first expires ${soonest.slice(0, 10)} (${days} days)` : ""}.`, url);
    }),
    tryCheck("mcp", "Results MCP server", async () => {
      const url = `${TESTER}/mcp`;
      const tools = (await mcpCall(fetchImpl, url, "tools/list"))?.tools || [];
      return tools.length ? ok("mcp", "Results MCP server", `${tools.length} read-only tools answer tools/list.`, url) : bad("mcp", "Results MCP server", "tools/list returned no tools.", url);
    }),
    tryCheck("results", "Public results database", async () => {
      const url = `${TESTER}/api/runs?limit=1`;
      const resp = await timed(fetchImpl, url);
      if (!resp.ok) return bad("results", "Public results database", `${url} answered ${resp.status}.`, url);
      const run = (await resp.json())?.runs?.[0];
      return ok("results", "Public results database", run ? `Latest stored run ${String(run.finished_at || "").slice(0, 10)}.` : "Answers; no runs stored yet.", url);
    }),
  ]);
}

const worst = (statuses) => (statuses.includes("fail") ? "fail" : statuses.includes("warn") ? "warn" : "ok");

/**
 * Check everything once.
 *
 * :param opts: {fetchImpl (default fetch), now (ms)}. Tests pass a fake fetch.
 * :return: {generated_at, status: "ok"|"warn"|"fail", groups: [{id, name, role, url, status,
 *     checks: [...]}]}. "expected" checks never lower the overall status.
 */
export async function healthReport({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const siteGroups = SITES.map(async (site) => {
    const [page, r, ...extras] = await Promise.all([
      pageCheck(fetchImpl, site.origin),
      checkNetwork(`${site.origin}/${site.network}`, { fetchImpl: (u, init = {}) => timed(fetchImpl, u, init), now }).catch((error) => ({ error: error.message })),
      ...site.extras.map((x) => EXTRAS[x](fetchImpl, site)),
    ]);
    const checks = [page, ...trustChecks(site, r, now), ...extras];
    return { id: site.id, name: site.name, role: site.role, url: `${site.origin}/`, network_url: `${site.origin}/${site.network}`, intended: site.expect === "refused", status: worst(checks.map((c) => c.status)), checks };
  });
  const tester = testerChecks(fetchImpl, now).then((checks) => ({
    id: "crashtest", name: "crash-test", role: "The tester: runs, signs and publishes attestations", url: `${TESTER}/`, intended: false, status: worst(checks.map((c) => c.status)), checks,
  }));
  const groups = await Promise.all([...siteGroups, tester]);
  return { generated_at: new Date(now).toISOString(), status: worst(groups.map((g) => g.status)), expiry_warn_days: EXPIRY_WARN_DAYS, groups };
}
