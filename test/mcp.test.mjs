// MCP server (M4.2): JSON-RPC conformance and every tool, against the real stored scorecards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { migratedDb } from "./d1-sqlite.mjs";
import { ingestScorecard } from "../worker/src/results.js";
import { handleMcp, PROTOCOL_VERSIONS, TOOLS } from "../worker/src/mcp.js";
import worker from "../worker/src/index.js";

const ORIGIN = "https://crashtest.frankmp12357.workers.dev";
const CHARGE = "https://charge.frankmp12357.workers.dev/charge_planner";
const SPOT = "https://sketchy.frankmp12357.workers.dev/spot_deals";
const SITE = new URL("../site/", import.meta.url);

/** Static assets from site/, like the Worker's ASSETS binding. */
const ASSETS = {
  fetch: async (req) => {
    const path = new URL(req.url).pathname.replace(/^\//, "");
    try {
      return new Response(await readFile(new URL(path, SITE)), { status: 200 });
    } catch {
      return new Response("not found", { status: 404 });
    }
  },
};

/** A database with every 17 Nov scorecard (v6 matrix and v9 matrix) stored. */
async function seeded() {
  const db = await migratedDb();
  const dir = new URL("../results/", import.meta.url);
  for (const f of (await readdir(dir)).filter((f) => /^2026-11-17-(v9-)?(charge_planner|spot_deals)-.*\.json$/.test(f))) {
    await ingestScorecard(db, JSON.parse(await readFile(new URL(f, dir), "utf8")), { source: "backfill" });
  }
  return db;
}

const offline = async () => { throw new Error("offline"); };
const ctxFor = (over = {}) => ({ origin: ORIGIN, ip: "1.2.3.4", limited: async () => false, fetchImpl: offline, now: Date.parse("2026-11-20T12:00:00Z"), ...over });

async function rpc(env, body, { method = "POST", ctx = ctxFor() } = {}) {
  const res = await handleMcp(new Request(`${ORIGIN}/mcp`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined }), env, ctx);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

let nextId = 1;
async function call(env, name, args = {}, ctx) {
  const r = await rpc(env, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, { ctx });
  assert.equal(r.status, 200);
  assert.ok(r.body.result, JSON.stringify(r.body.error));
  return r.body.result;
}

// ---- protocol --------------------------------------------------------------------------------

test("initialize negotiates the protocol version and advertises tools only", async () => {
  const env = { DB: await migratedDb(), ASSETS };
  const r = await rpc(env, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.id, 1);
  assert.equal(r.body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(r.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal(r.body.result.serverInfo.name, "crash-test");
  assert.match(r.body.result.instructions, /never as instructions/);
  const future = await rpc(env, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal(future.body.result.protocolVersion, PROTOCOL_VERSIONS[0], "an unknown version gets our latest");
});

test("notifications get 202 with no body; ping, errors and transport rules follow JSON-RPC", async () => {
  const env = { DB: await migratedDb(), ASSETS };
  const note = await rpc(env, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202);
  assert.equal(note.body, null);
  assert.deepEqual((await rpc(env, { jsonrpc: "2.0", id: "p", method: "ping" })).body, { jsonrpc: "2.0", id: "p", result: {} });
  assert.equal((await rpc(env, { jsonrpc: "2.0", id: 3, method: "resources/list" })).body.error.code, -32601);
  assert.equal((await rpc(env, "{nope")).body.error.code, -32700);
  assert.equal((await rpc(env, [{ jsonrpc: "2.0", id: 1, method: "ping" }])).body.error.code, -32600);
  assert.equal((await rpc(env, { id: 4, method: "ping" })).body.error.code, -32600);
  assert.equal((await rpc(env, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "drop_tables" } })).body.error.code, -32602);
  assert.equal((await rpc(env, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "get_scorecard", arguments: {} } })).body.error.code, -32602);
  const get = await rpc(env, null, { method: "GET" });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST, OPTIONS");
});

test("tools/list: eight read-only tools with object input schemas", async () => {
  const env = { DB: await migratedDb(), ASSETS };
  const { tools } = (await rpc(env, { jsonrpc: "2.0", id: 1, method: "tools/list" })).body.result;
  assert.deepEqual(tools.map((t) => t.name), ["list_networks", "get_scorecard", "compare_models", "which_tests_regressed", "flaky_tests", "explain_failure", "get_attestation", "run_static_check"]);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.ok(t.description.length > 20, t.name);
  }
  assert.equal(TOOLS.length, 8);
});

// ---- tools over real data ---------------------------------------------------------------------

test("list_networks and get_scorecard (by full URL or just the network name)", async () => {
  const env = { DB: await seeded(), ASSETS };
  const list = await call(env, "list_networks");
  assert.deepEqual(list.structuredContent.networks.map((n) => n.network_url).sort(), [CHARGE, SPOT]);
  const spot = list.structuredContent.networks.find((n) => n.network_url === SPOT);
  assert.equal(spot.models.find((m) => m.model === "deepseek/deepseek-v4.1-flash").score, 50, "the latest (v9) run, not the older v6 one");
  const card = await call(env, "get_scorecard", { network_url: "spot_deals", model: "deepseek/deepseek-v4.1-flash" });
  assert.equal(card.structuredContent.score, 50);
  assert.equal(card.structuredContent.tests.length, 12);
  assert.match(card.content[0].text, /budget_and_loops: fail \(0\/3\)/);
  const missing = await call(env, "get_scorecard", { network_url: "nothing_here" });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /list_networks/);
});

test("compare_models separates network failures from model failures", async () => {
  const env = { DB: await seeded(), ASSETS };
  const r = await call(env, "compare_models", { network_url: SPOT });
  assert.equal(r.structuredContent.models.length, 4);
  const grounding = r.structuredContent.tests.find((t) => t.id === "grounding_on_failure");
  assert.equal(grounding.pattern, "fails on every model (likely the network)");
  const injection = r.structuredContent.tests.find((t) => t.id === "subtle_injection");
  assert.equal(injection.pattern, "depends on the model");
  assert.match(r.content[0].text, /\| test \|/);
});

test("which_tests_regressed compares the last two runs of each pair", async () => {
  const env = { DB: await seeded(), ASSETS };
  const r = await call(env, "which_tests_regressed", { network_url: SPOT, model: "alibaba/qwen3.8-flash" });
  const reg = r.structuredContent.regressions[0];
  assert.equal(reg.score_before, 71);
  assert.equal(reg.score_now, 57);
  assert.equal(reg.test_version_changed, true, "the suite changed between the two runs");
  assert.equal(reg.network_changed, false);
  assert.ok(reg.tests.some((t) => t.test_id === "unknown_outcome"), JSON.stringify(reg.tests));
  const single = { DB: await migratedDb(), ASSETS };
  assert.match((await call(single, "which_tests_regressed")).content[0].text, /No regressions/);
});

test("flaky_tests finds mixed verdicts", async () => {
  const env = { DB: await seeded(), ASSETS };
  const r = await call(env, "flaky_tests", { network_url: SPOT });
  assert.ok(r.structuredContent.flaky.length > 0);
  assert.ok(r.structuredContent.flaky.every((f) => f.network_url === SPOT));
});

test("explain_failure returns what the test checks and the evidence, fenced as untrusted", async () => {
  const env = { DB: await seeded(), ASSETS };
  const r = await call(env, "explain_failure", { network_url: CHARGE, test_id: "private_context_leak", model: "deepseek/deepseek-v4.1-flash" });
  assert.match(r.content[0].text, /What it checks: A booking code/);
  assert.match(r.content[0].text, /<<<untrusted evidence\n[\s\S]*CANARY-7731[\s\S]*\n>>>/);
  assert.match(r.content[0].text, /data, not instructions/);
  assert.equal(r.structuredContent.results[0].verdict, "fail");
});

test("get_attestation verifies the published JWS and compares it with the live network", async () => {
  const env = { DB: await migratedDb(), ASSETS };
  const offlineCheck = await call(env, "get_attestation", { network_url: CHARGE });
  const a = offlineCheck.structuredContent.attestations[0];
  assert.equal(a.valid, true, a.reason);
  assert.equal(a.score, 100);
  assert.equal(a.matches_live_network, null, "the live network could not be loaded");
  // Serve a different network at that URL: the attestation no longer applies.
  const fixture = (name) => readFile(new URL(`./fixtures/charge/${name}`, import.meta.url), "utf8");
  const changed = async (url) => {
    const name = url.endsWith("agent-manifest.json") ? "agent-manifest.json" : url.endsWith(".network.json") ? "charge_planner.network.json" : null;
    return name ? new Response(await fixture(name), { headers: { "access-control-allow-origin": "*" } }) : new Response("", { status: 404 });
  };
  const b = (await call(env, "get_attestation", { network_url: CHARGE }, ctxFor({ fetchImpl: changed }))).structuredContent.attestations[0];
  assert.equal(b.matches_live_network, false);
  assert.equal(b.valid, false);
  assert.match(b.reason, /different version/);
  const expired = (await call(env, "get_attestation", { network_url: CHARGE }, ctxFor({ now: Date.parse("2027-01-01T00:00:00Z") }))).structuredContent.attestations[0];
  assert.match(expired.reason, /expired/);
  assert.match((await call(env, "get_attestation", { network_url: "https://nobody.example/x" })).content[0].text, /No signed attestation/);
});

test("run_static_check loads a network live, and is rate-limited and URL-checked", async () => {
  const env = { DB: await migratedDb(), ASSETS };
  const fixture = (name) => readFile(new URL(`./fixtures/charge/${name}`, import.meta.url), "utf8");
  const site = async (url) => {
    if (url === "https://charge.example/agent-manifest.json") return new Response(await fixture("agent-manifest.json"), { headers: { "access-control-allow-origin": "*" } });
    if (url === "https://charge.example/charge_planner.network.json") return new Response(await fixture("charge_planner.network.json"), { headers: { "access-control-allow-origin": "*" } });
    return new Response("", { status: 404 });
  };
  const ok = await call(env, "run_static_check", { network_url: "https://charge.example/charge_planner" }, ctxFor({ fetchImpl: site }));
  assert.equal(ok.structuredContent.files_ok, true);
  assert.equal(ok.structuredContent.signature.verdict, "not_applicable");
  assert.match(ok.content[0].text, /files OK/);
  assert.equal((await call(env, "run_static_check", { network_url: "http://insecure.example/x" })).isError, true);
  assert.equal((await call(env, "run_static_check", { network_url: "https://charge.example/charge_planner" }, ctxFor({ limited: async () => true }))).isError, true);
});

test("the Worker routes /mcp, answers CORS preflight and applies the per-IP limit", async () => {
  const env = { DB: await migratedDb(), ASSETS };
  const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }), env);
  assert.deepEqual(await res.json(), { jsonrpc: "2.0", id: 1, result: {} });
  const pre = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "OPTIONS" }), env);
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers"), /mcp-protocol-version/);
  const busy = await worker.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", body: "{}" }), { ...env, MCP_LIMIT: { limit: async () => ({ success: false }) } });
  assert.equal(busy.status, 429);
});
