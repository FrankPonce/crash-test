// /health: the project's live pieces, checked with the same code that admits callers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { healthReport, trustChecks, SITES, TESTER, EXPIRY_WARN_DAYS } from "../worker/src/health.js";
import worker, { clearHealthCache } from "../worker/src/index.js";

const NOW = Date.parse("2026-12-01T12:00:00Z");
const charge = SITES.find((s) => s.id === "charge");
const sketchy = SITES.find((s) => s.id === "sketchy");
const days = (n) => new Date(NOW + n * 864e5).toISOString();
const signed = { ok: true, status: "valid", by: charge.origin, kid: "abcdefghijklmnop" };
const attested = (exp) => ({ ok: true, score: 100, coverage: 100, model: "alibaba/qwen3.8-flash", test_version: 20, exp, failed: [], results: {} });

test("a signed site with a fresh attestation is ok; one about to expire is a warning", () => {
  const fresh = trustChecks(charge, { network_sha256: "a".repeat(64), signature: signed, attestation: attested(days(20)) }, NOW);
  assert.deepEqual(fresh.map((c) => [c.id, c.status]), [["signature", "ok"], ["attestation", "ok"]]);
  assert.match(fresh[1].detail, /valid until 2026-12-21 \(20 days\)/);
  assert.match(fresh[1].evidence, /^https:\/\/crashtest\.frankmp12357\.workers\.dev\/\?url=/);
  const soon = trustChecks(charge, { network_sha256: "a".repeat(64), signature: signed, attestation: attested(days(EXPIRY_WARN_DAYS - 1)) }, NOW);
  assert.equal(soon[1].status, "warn");
  assert.match(soon[1].detail, /Re-attest soon/);
});

test("a broken signature or a refused attestation on our own site is a failure", () => {
  const r = trustChecks(charge, { network_sha256: "a".repeat(64), signature: { ok: false, status: "invalid", reason: "the network changed after it was signed" }, attestation: { ok: false, reason: "attests a different set of site actions", failed: [], results: {} } }, NOW);
  assert.deepEqual(r.map((c) => c.status), ["fail", "fail"]);
  assert.match(r[1].detail, /different set of site actions/);
});

test("the bad fixture refused is 'expected'; the bad fixture admitted would be the failure", () => {
  const refused = trustChecks(sketchy, { network_sha256: "b".repeat(64), signature: { ok: false, status: "unsigned", reason: "no signature file (HTTP 404)" }, attestation: { ok: false, score: 82, reason: "failed outright: grounding_on_failure (score 82)", failed: ["grounding_on_failure"], results: {} } }, NOW);
  assert.deepEqual(refused.map((c) => c.status), ["expected", "expected"]);
  assert.match(refused[1].detail, /Tested 82\/100, refused/);
  const admitted = trustChecks(sketchy, { network_sha256: "b".repeat(64), signature: { ok: false, status: "unsigned", reason: "x" }, attestation: attested(days(20)) }, NOW);
  assert.equal(admitted[1].status, "fail");
});

test("healthReport: everything down is a failure, but the fixture's intended states never lower the status", async () => {
  const down = async () => new Response("nope", { status: 503 });
  const r = await healthReport({ fetchImpl: down, now: NOW });
  assert.equal(r.status, "fail");
  assert.deepEqual(r.groups.map((g) => g.id), ["charge", "taloyhtio", "sketchy", "crashtest"]);
  assert.ok(r.groups.every((g) => g.checks.length > 0));
  assert.equal(r.groups.find((g) => g.id === "sketchy").intended, true);
  // Unreachable is a real failure, even for the fixture: it must be up to be refused.
  assert.equal(r.groups.find((g) => g.id === "sketchy").checks[0].status, "fail");
});

test("GET /api/health is public JSON, cached for a minute, and answers the tester's own URLs itself", async () => {
  clearHealthCache();
  const realFetch = globalThis.fetch;
  const outside = [];
  globalThis.fetch = async (u) => {
    outside.push(String(u));
    return new Response("nope", { status: 503 });
  };
  const assets = [];
  const env = { ASSETS: { fetch: async (req) => { assets.push(new URL(req.url).pathname); return new Response("<!doctype html>", { headers: { "content-type": "text/html" } }); } } };
  try {
    const resp = await worker.fetch(new Request(`${TESTER}/api/health`), env);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("access-control-allow-origin"), "*");
    assert.match(resp.headers.get("cache-control"), /max-age=60/);
    const body = await resp.json();
    assert.equal(body.groups.length, 4);
    assert.ok(!outside.some((u) => u.startsWith(TESTER)), "no fetch back to itself");
    assert.ok(assets.includes("/"), "its own page came from its assets");
    const n = outside.length;
    await worker.fetch(new Request(`${TESTER}/api/health`), env);
    assert.equal(outside.length, n, "second call within a minute is cached");
  } finally {
    globalThis.fetch = realFetch;
    clearHealthCache();
  }
});
