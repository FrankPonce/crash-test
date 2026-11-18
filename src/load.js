// Load a published agent network the way another agent site would (spec §3.2):
// the URL's last path part is the network name, the rest is the site base, and the
// manifest at <base>/agent-manifest.json maps the name to its network definition.
// Only public, declarative files are fetched. No site code is downloaded or run.

import { actionsSha256 } from "agent-trust-kit/attestation";
import canonicalize from "canonicalize";
import { AgentNetwork, validateNetwork } from "../vendor/runtime/kernel.js";

const TESTER_ORIGIN = "https://crash-test.invalid";

/**
 * Split a network URL into site base and network name.
 *
 * :param networkUrl: Such as https://site.example/charge_planner.
 * :return: {base, name, manifestUrl}.
 * :raises Error: When the URL is not http(s) or has no network name.
 */
export function parseNetworkUrl(networkUrl) {
  let url;
  try {
    url = new URL(networkUrl);
  } catch {
    throw new Error(`Not a URL: ${networkUrl}`);
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Network URLs must be http or https.");
  const parts = url.pathname.split("/").filter(Boolean);
  const name = decodeURIComponent(parts.pop() || "");
  if (!name) throw new Error("The URL must end with the network name, such as https://site.example/my_network.");
  const base = `${url.origin}/${parts.map(encodeURIComponent).join("/")}${parts.length ? "/" : ""}`;
  return { base, name, manifestUrl: new URL("agent-manifest.json", base).href };
}

/**
 * Fetch and check the published network.
 *
 * :param networkUrl: The network URL.
 * :param opts: {fetchImpl} for tests.
 * :return: {target, checks}. target has base, name, manifest, config, network,
 *     networkUrl, hoconUrl and sha256 (of the JCS-canonical network JSON). checks is a
 *     list of {id, ok, detail} for the static test.
 */
export async function loadTarget(networkUrl, { fetchImpl = globalThis.fetch } = {}) {
  const { base, name, manifestUrl } = parseNetworkUrl(networkUrl);
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok: !!ok, detail });

  const manifestResp = await fetchImpl(manifestUrl, { headers: { Origin: TESTER_ORIGIN }, redirect: "follow" });
  check("manifest_fetch", manifestResp.ok, `GET ${manifestUrl} → ${manifestResp.status}`);
  if (!manifestResp.ok) return { target: null, checks };
  check("manifest_cors", corsAllows(manifestResp), `Access-Control-Allow-Origin: ${manifestResp.headers.get("access-control-allow-origin") ?? "(none)"}`);
  let manifest;
  try {
    manifest = await manifestResp.json();
  } catch {
    check("manifest_json", false, "agent-manifest.json is not valid JSON");
    return { target: null, checks };
  }
  const entry = (manifest.networks || []).find((n) => n?.name === name);
  check("network_listed", !!entry, entry ? `network "${name}" listed` : `no network named exactly "${name}" in the manifest`);
  if (!entry) return { target: null, checks };

  const hoconUrl = new URL(entry.hocon, base).href;
  const netResp = await fetchImpl(hoconUrl, { headers: { Origin: TESTER_ORIGIN }, redirect: "follow" });
  check("network_fetch", netResp.ok, `GET ${hoconUrl} → ${netResp.status}`);
  if (!netResp.ok) return { target: null, checks };
  check("network_cors", corsAllows(netResp), `Access-Control-Allow-Origin: ${netResp.headers.get("access-control-allow-origin") ?? "(none)"}`);
  const bytes = new Uint8Array(await netResp.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    check("network_json", false, "The network file is not valid JSON (the browser runtime loads JSON).");
    return { target: null, checks };
  }

  let network;
  try {
    network = new AgentNetwork(config, name);
    const v = validateNetwork(network);
    check("runtime_validation", v.errors.length === 0, v.errors.length ? v.errors.join("; ") : `valid${v.warnings?.length ? ` (${v.warnings.length} warnings)` : ""}`);
    if (v.errors.length) return { target: null, checks };
  } catch (error) {
    check("runtime_validation", false, String(error.message || error));
    return { target: null, checks };
  }
  const frontMan = network.findFrontMan();
  check("front_agent", frontMan && frontMan === entry.front_man, `manifest front_man "${entry.front_man}", network front agent "${frontMan}"`);
  const demo = demoModeFindings(network.config); // expanded: shared strings filled in
  check("no_demo_mode", demo.length === 0, demo.length ? `demo mode or an instruction to invent results: ${demo.join(" | ")}` : "no demo mode or instructions to invent results");
  const policy = manifest.peer_policy?.mode;
  check("peer_policy", policy === "closed" || policy === "open", `peer_policy.mode = ${policy ?? "(missing)"}`);

  const sha256 = await sha256Hex(canonicalize(config));
  // The file's bytes as served, for tools that hash files directly (in-toto subject "sha256").
  const fileSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return {
    // The site's declared actions (manifest `actions`), bound into attestations as a second subject (F39).
    target: { networkUrl, base, name, manifest, entry, config, network, frontMan, hoconUrl, sha256, fileSha256, actionsSha256: await actionsSha256(manifest) },
    checks,
  };
}

const INVENT = /\b(make up a realistic|make up (a|some|plausible)|invent (a|an|some|plausible)|pretend (that )?(it|the order|the booking) (worked|succeeded))\b/i;
const NEGATED = /\b(do not|don't|never|not|no|nor|without|avoid|refuse to|must not|should not)\b/i;

/**
 * Where a network turns on demo mode or tells an agent to invent results. A demo_mode
 * flag set on the network or an agent counts; so does an instruction sentence such as
 * "make up a realistic price", unless the sentence negates it ("do not invent a result").
 * Mentioning demo mode in prose (a checker explaining what it checks) does not count.
 *
 * :param config: The network JSON.
 * :return: Short evidence strings, empty when clean.
 */
export function demoModeFindings(config) {
  const found = [];
  const flagged = (obj) => obj && typeof obj === "object" && obj.demo_mode !== undefined && obj.demo_mode !== false;
  if (flagged(config)) found.push("demo_mode set on the network");
  for (const agent of config?.tools || []) {
    if (flagged(agent)) found.push(`demo_mode set on ${agent.name}`);
    for (const field of ["instructions", "command"]) {
      for (const sentence of String(agent?.[field] ?? "").split(/(?<=[.!?\n])\s+/)) {
        if (INVENT.test(sentence) && !NEGATED.test(sentence)) found.push(`${agent.name}: "${sentence.trim().slice(0, 120)}"`);
      }
    }
  }
  return found;
}

function corsAllows(resp) {
  // In a browser, scripts cannot read this header, but a cross-origin response that
  // arrives at all (type "cors") passed the CORS check. In Node, read the header.
  if (resp.type === "cors") return true;
  const v = resp.headers.get("access-control-allow-origin");
  return v === "*" || v === TESTER_ORIGIN;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
