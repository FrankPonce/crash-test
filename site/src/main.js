// Crash-test in the browser. Bundled to site/app.js by `npm run build:site`.
// Runs the same engine as the CLI, in the visitor's browser, against the target site's
// public files (which the spec already requires to allow cross-site reads). Results here
// are unsigned. Signed attestations are made offline with the tester key and published
// under /attestations/; this page verifies them with the tester's public keys.

import { LlmClient } from "../../vendor/runtime/llm.js";
import { crashTest } from "../../src/run.js";
import { loadTarget } from "../../src/load.js";
import { fixedModel } from "../../src/model.js";
import { TESTS } from "../../src/tests/index.js";
import { verifyAttestation } from "agent-trust-kit/attestation";

const SITE_MODEL = "@cf/openai/gpt-oss-20b";
// Grades unclear runs only (FINDINGS F22). A different model from SITE_MODEL, same free proxy.
const SITE_JUDGE = "@cf/zai-org/glm-4.7-flash";
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((k) => k !== null && k !== undefined));
  return e;
};

const VERDICT = {
  pass: ["pass", "Pass"],
  fail: ["fail", "Fail"],
  flaky: ["warn", "Flaky"],
  inconclusive: ["warn", "Unclear"],
  not_applicable: ["muted", "N/A"],
  error: ["muted", "Error"],
  skipped: ["muted", "Skipped"],
};

let running = null;

/** Build the model client the visitor chose. */
async function chooseModel() {
  const mode = document.querySelector("input[name=mode]:checked").value;
  if (mode === "site") {
    const resp = await fetch("api/session", { method: "POST" });
    if (!resp.ok) throw new Error((await resp.json().catch(() => ({})))?.error?.message || `Could not start a session (HTTP ${resp.status}).`);
    const { token } = await resp.json();
    const client = new LlmClient({ baseUrl: new URL("api/llm/v1", location.href).href.replace(/\/$/, ""), apiKey: token });
    const routerHost = `${location.host} (Workers AI)`;
    return { llm: fixedModel(client, SITE_MODEL), model: { name: SITE_MODEL, routerHost }, judges: [{ llm: fixedModel(client, SITE_JUDGE), model: { name: SITE_JUDGE, routerHost } }], runs: 1 };
  }
  const router = $("#router").value.trim().replace(/\/$/, "");
  const key = $("#key").value.trim();
  const name = $("#model").value.trim();
  if (!router || !key || !name) throw new Error("Enter a router URL, your API key and a model name, or use the site's free model.");
  const client = new LlmClient({ baseUrl: router, apiKey: key });
  return { llm: fixedModel(client, name), model: { name, routerHost: new URL(router).host }, runs: Number($("#runs").value) || 3 };
}

async function run(event) {
  event.preventDefault();
  if (running) return;
  const url = $("#url").value.trim();
  const status = $("#status");
  const progress = $("#progress");
  const results = $("#results");
  results.hidden = true;
  progress.replaceChildren();
  status.textContent = "";
  let setup;
  try {
    new URL(url);
    setup = await chooseModel();
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  running = true;
  $("#run").disabled = true;
  status.textContent = `Running on ${setup.model.name}. Model-based tests run ${setup.runs}× each; this takes a few minutes.`;
  const rows = new Map();
  for (const t of TESTS) {
    const row = el("li", { class: "pending" }, el("span", { class: "dot" }), el("span", { text: t.title }), el("span", { class: "runs" }));
    rows.set(t.id, row);
    progress.append(row);
  }
  try {
    const scorecard = await crashTest(url, {
      ...setup,
      fetchImpl: (u, o) => fetch(u, o),
      retryDelayMs: 3000,
      onProgress: (e) => {
        const row = rows.get(e.test);
        if (!row) return;
        if (e.type === "run") row.className = "active";
        if (e.type === "result") row.querySelector(".runs").append(el("span", { class: `chip ${VERDICT[e.verdict]?.[0] ?? "muted"}`, text: VERDICT[e.verdict]?.[1] ?? e.verdict }));
        if (e.type === "judge") row.querySelector(".runs").append(el("span", { class: "chip muted", text: "judge" }));
        if (e.type === "retry") row.querySelector(".runs").append(el("span", { class: "chip muted", text: "retry" }));
      },
    });
    status.textContent = "";
    showScorecard(scorecard);
    await showAttestations(scorecard.target.network_url, scorecard.target.network_sha256);
  } catch (error) {
    status.textContent = `The run stopped: ${error.message}`;
  } finally {
    running = null;
    $("#run").disabled = false;
  }
}

function showScorecard(card) {
  const results = $("#results");
  results.hidden = false;
  $("#score").textContent = card.summary.score;
  const cov = card.summary.coverage;
  $("#score-meta").textContent = `${cov == null ? "" : `coverage ${cov}% (${card.summary.decided_tests} of ${card.summary.applicable_tests} tests decided; unclear runs lower coverage, not the score) · `}${card.target.network_url} · ${card.model.name} via ${card.model.routerHost} · ${card.runs_per_test} run(s) per test${card.judges?.length ? ` · judge ${card.judges.map((j) => j.name).join(" + ")}` : ""} · unsigned`;
  $("#hash").textContent = card.target.network_sha256 ? `network sha256 ${card.target.network_sha256}` : "network did not load";
  const body = $("#tests");
  body.replaceChildren(...card.tests.map((t) => {
    const [cls, label] = VERDICT[t.verdict] ?? ["muted", t.verdict];
    const applicable = t.runs.filter((r) => !["not_applicable", "error"].includes(r.verdict));
    const passes = applicable.filter((r) => r.verdict === "pass").length;
    const details = el("details", {}, el("summary", { text: "Evidence" }), ...t.runs.map((r, i) => el("p", {}, el("strong", { text: `Run ${i + 1}: ${VERDICT[r.verdict]?.[1] ?? r.verdict}. ` }), r.evidence, r.judged_by ? el("em", { text: ` Judged by ${[].concat(r.judged_by).join(" + ")}: ${r.judge_reason ?? (r.judge_votes || []).map((v) => `${v.judge} ${v.verdict}${v.error ? ` (${v.error})` : ""}`).join(", ")}` }) : null)));
    return el("tr", {}, el("td", {}, el("strong", { text: t.title }), el("br"), el("code", { text: t.id })), el("td", {}, el("span", { class: `chip ${cls}`, text: label })), el("td", { text: applicable.length ? `${passes}/${applicable.length}` : "–" }), el("td", {}, details));
  }));
  const blob = new Blob([JSON.stringify(card, null, 2)], { type: "application/json" });
  const a = $("#download");
  a.href = URL.createObjectURL(blob);
  a.download = `crash-test-${(card.target.network_url || "network").split("/").pop()}.json`;
}

/** Show published attestations for this network, verified here with the tester's keys. */
async function showAttestations(networkUrl, currentHash) {
  const box = $("#attestations");
  box.replaceChildren();
  let index;
  try {
    index = await (await fetch("attestations/index.json", { cache: "no-store" })).json();
  } catch {
    box.append(el("p", { class: "muted", text: "No attestation index found." }));
    return;
  }
  const mine = (index.attestations || []).filter((a) => a.sub === networkUrl);
  if (!mine.length) {
    box.append(el("p", { class: "muted", text: "No signed attestation has been published for this network yet. The results above are unsigned." }));
    return;
  }
  for (const a of mine) {
    // New entries: in-toto statement in a DSSE envelope (a.attestation); older ones: a JWS (a.jws).
    const file = a.attestation ?? a.jws;
    const signed = (await (await fetch(file, { cache: "no-store" })).text()).trim();
    const v = await verifyAttestation(signed, { issuer: location.origin, expect: currentHash ? { network_sha256: currentHash } : {} });
    const s = v.statement;
    const ok = v.ok;
    box.append(el("div", { class: `attest ${ok ? "ok" : "bad"}` },
      el("strong", { text: ok ? "✓ Signed attestation verified" : "✗ Attestation does not apply" }),
      el("p", { text: s ? `Score ${s.score}${s.coverage == null ? "" : ` (coverage ${s.coverage}%)`} on ${s.model?.name} (${s.runs_per_test} runs per test), issued ${s.iat.slice(0, 10)}, valid until ${s.exp.slice(0, 10)}.` : "" }),
      ok ? null : el("p", { class: "muted", text: `Reason: ${v.reason}.` }),
      s?.judges?.length ? el("p", { class: "muted", text: judgedNote(s) }) : null,
      el("p", {}, el("img", { src: a.badge, alt: `crash-test badge: score ${s?.score ?? "?"}` }), " ", el("a", { href: file, text: a.attestation ? "in-toto attestation (DSSE)" : "JWS" }), " · ", el("a", { href: a.scorecard, text: "full scorecard" }))));
  }
}

/** "2 runs were decided by the judge panel (…)", or a note that none were. */
function judgedNote(s) {
  const judged = Object.values(s.results || {}).reduce((n, r) => n + (r.judged_runs || 0), 0);
  const panel = s.judges.join(" + ");
  return judged
    ? `${judged} unclear run${judged === 1 ? " was" : "s were"} decided by the judge panel (${panel}, both must agree); every other verdict is deterministic.`
    : `Every verdict is deterministic; the judge panel (${panel}) was not needed.`;
}

function preset(event) {
  const url = event.target.dataset.url;
  if (url) $("#url").value = url;
}

function toggleMode() {
  $("#own-key").hidden = document.querySelector("input[name=mode]:checked").value !== "own";
}

$("#run-form").addEventListener("submit", run);
for (const b of document.querySelectorAll("[data-url]")) b.addEventListener("click", preset);
for (const r of document.querySelectorAll("input[name=mode]")) r.addEventListener("change", toggleMode);
toggleMode();
// Deep link: ?url=<network-url> fills the form and shows published attestations.
const params = new URLSearchParams(location.search);
if (params.get("url")) {
  $("#url").value = params.get("url");
  loadTarget(params.get("url"))
    .then(({ target }) => showAttestations(params.get("url"), target?.sha256 ?? null))
    .catch(() => showAttestations(params.get("url"), null));
}
