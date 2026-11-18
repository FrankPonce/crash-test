// /health: render GET api/health as passports. Data only ever goes in through textContent;
// the only HTML strings are the fixed icons below.

const ICON = {
  ok: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>',
  fail: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15"/></svg>',
  warn: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 6v4.5l3 2"/></svg>',
  // An intended refusal: a barrier, not a cross. The system working, not something broken.
  expected: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M5.2 14.8L14.8 5.2"/></svg>',
};
const iconFor = (status) => ICON[status] ?? ICON.fail;
const VISA_CLASS = { ok: "", warn: "warn", fail: "fail", expected: "designed" };

const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "icon") node.insertAdjacentHTML("afterbegin", v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
const link = (href, text) => (href ? el("a", { href, rel: "noopener" }, text) : text);
const date = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const time = (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const find = (g, id) => g.checks.find((c) => c.id === id);

/** A visa: state line with its label, one line of meaning, then dates, proof and anything on request. */
function visa(label, status, state, meaning, ...rest) {
  return el("div", { class: `visa ${VISA_CLASS[status] ?? "fail"}` },
    el("div", { class: "v-head" }, el("p", { class: "v-state", icon: iconFor(status) }, state), el("span", { class: "v-label" }, label)),
    meaning ? el("p", { class: "v-detail" }, meaning) : null,
    ...rest);
}
const onRequest = (summary, ...lines) => el("details", { class: "v-more" }, el("summary", {}, summary), ...lines.map((l) => el("p", {}, l)));

function identityVisa(c) {
  const d = c?.data || {};
  if (!c) return visa("Identity", "fail", "Not checked", "The network could not be loaded.");
  if (c.status === "expected") {
    return visa("Identity", "expected", "Unsigned, as designed", "It publishes no signature and no keys, so who published it is not proven.",
      onRequest("Hash of the served network", d.network_sha256 || "unknown"));
  }
  if (c.status === "ok") {
    return visa("Identity", "ok", "Signed by its domain", "What it serves now is exactly what its domain signed.",
      el("p", { class: "v-data" }, link(c.evidence, "signature file")),
      onRequest("Hash and key", `network ${d.network_sha256}`, `key ${d.kid} at ${d.host}`));
  }
  return visa("Identity", c.status, c.status === "warn" ? "Signed (unexpected)" : "Signature does not hold", c.detail, el("p", { class: "v-data" }, link(c.evidence, "signature file")));
}

function behaviourVisa(c) {
  const d = c?.data || {};
  if (!c) return null;
  const proof = link(c.evidence, "signed result");
  if (c.status === "ok" || c.status === "warn") {
    return visa("Behaviour", c.status, `Tested ${d.score} / 100`,
      `Coverage ${d.coverage}% on ${String(d.model).split("/").pop()}, test version ${d.test_version}.${c.status === "warn" ? " Re-attest soon." : ""}`,
      el("p", { class: "v-data" }, `valid until ${date(d.exp)} (${d.days_left} days) · `, proof));
  }
  if (c.status === "expected") {
    return visa("Behaviour", "expected", Number.isFinite(d.score) ? `Tested ${d.score} / 100, not vouched for` : "Not vouched for",
      d.failed?.length ? `Failed outright: ${d.failed.join(", ").replace(/_/g, " ")}.` : c.detail,
      el("p", { class: "v-data" }, proof));
  }
  return visa("Behaviour", "fail", "Not vouched for", c.detail, el("p", { class: "v-data" }, proof));
}

const THIRD = {
  peer_trust: { label: "Partners", ok: "Shows its partner as trusted", meaning: "Its consent card shows visitors the partner is signed and tested.", proof: "partner report" },
  arbiter_mcp: { label: "Arbiter", ok: "Takes requests on /mcp", meaning: "Answers its rules and admits only signed, tested callers.", proof: "MCP endpoint" },
};
const thirdId = (g) => (g.intended ? null : ["arbiter_mcp", "peer_trust"].find((x) => find(g, x)));

function thirdVisa(g) {
  if (g.intended) {
    return visa("Refusal", "expected", "Turned away by code", "The arbiter refuses a network that is unsigned or failed a test outright. Both are true here, on purpose.");
  }
  const id = thirdId(g);
  const c = id && find(g, id);
  if (!c) return null;
  const t = THIRD[id];
  return visa(t.label, c.status, c.status === "ok" ? t.ok : c.label, c.status === "ok" ? t.meaning : c.detail, el("p", { class: "v-data" }, link(c.evidence, t.proof)));
}

/** Everything else, as one quiet line; problems are named in it. */
function quietLine(g, used) {
  const rest = g.checks.filter((c) => !["signature", "attestation", "network", used].includes(c.id));
  if (!rest.length) return null;
  const okOnes = rest.filter((c) => c.status === "ok");
  const bad = rest.filter((c) => c.status !== "ok");
  const short = { page: "site", default_model: "free model", peer_trust: "partner card", arbiter_mcp: "arbiter" };
  const parts = [];
  if (okOnes.length) parts.push("Also up: ", ...okOnes.flatMap((c, i) => [i ? ", " : "", link(c.evidence, short[c.id] || c.label.toLowerCase())]), ".");
  for (const c of bad) parts.push(" ", el("span", { class: "q-bad", icon: iconFor(c.status) }, link(c.evidence, c.label)), `: ${c.detail}`);
  return el("p", { class: "pp-quiet" }, ...parts);
}

function sealFor(g, at) {
  const statuses = g.checks.map((c) => c.status);
  const day = date(at).toUpperCase();
  if (g.intended) {
    if (find(g, "page")?.status === "fail") return { color: "red", text: "OFFLINE", note: `${day} · SHOULD BE UP` };
    if (statuses.includes("fail") || statuses.includes("warn")) return { color: "red", text: "CHECK", note: `${day} · SHOULD BE REFUSED` };
    return { color: "red", text: "ENTRY REFUSED", note: `${day} · AS DESIGNED` };
  }
  if (statuses.includes("fail")) return { color: "red", text: "NOT ADMITTED", note: `${day} · NEEDS FIXING` };
  const days = find(g, "attestation")?.data?.days_left;
  if (statuses.includes("warn")) return { color: "amber", text: "ADMITTED", note: Number.isFinite(days) && days < 7 ? `EXPIRES IN ${days} DAYS` : `${day} · NEEDS A LOOK` };
  return { color: "", text: "ADMITTED", note: day };
}

/** The arbiter's stamp: a double ring, the issuer set around it, the decision and date inside. */
const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  return n;
}
let sealIds = 0;
function seal(s, i, pressed) {
  const id = `ring-${++sealIds}`;
  const words = s.text.split(" ");
  const root = svg("svg", { viewBox: "0 0 120 120", class: `seal ${s.color}${pressed ? " press" : ""}`, style: `--i:${i}`, "aria-hidden": "true" });
  root.append(
    svg("circle", { cx: 60, cy: 60, r: 57, class: "ring" }),
    svg("circle", { cx: 60, cy: 60, r: 53, class: "ring thin" }),
    svg("circle", { cx: 60, cy: 60, r: 38, class: "ring thin" }),
    svg("path", { id, d: "M60,60 m-45.5,0 a45.5,45.5 0 1,1 91,0 a45.5,45.5 0 1,1 -91,0", fill: "none" }),
  );
  const ring = svg("text", { class: "issuer" });
  ring.append(svg("textPath", { href: `#${id}`, startOffset: "0", textLength: "282" }, "BY THE ARBITER · DECIDED BY CODE · "));
  root.append(ring);
  // Decision words, then the date and any note on their own short lines, all inside the inner ring.
  const notes = s.note.split(" · ");
  const lines = words.length + notes.length;
  let y = 60 - ((lines - 1) * 10.5) / 2 + 2;
  words.forEach((w) => { root.append(svg("text", { x: 60, y, class: "word" }, w)); y += 12; });
  notes.forEach((n) => { root.append(svg("text", { x: 60, y: y - 1, class: "date" }, n)); y += 9; });
  return root;
}

function passport(g, i, pressed, at) {
  const s = sealFor(g, at);
  return el("section", { class: `passport${g.intended ? " intended" : ""}`, "aria-label": `${g.name}: ${s.text.toLowerCase()}, ${s.note.toLowerCase()}` },
    el("div", { class: "pp-id" }, el("h2", {}, g.name), el("p", {}, g.role), link(g.network_url, new URL(g.network_url).host)),
    identityVisa(find(g, "signature") || find(g, "network")),
    behaviourVisa(find(g, "attestation")),
    thirdVisa(g),
    el("div", { class: "pp-stamp" }, quietLine(g, thirdId(g)), seal(s, i, pressed)));
}

function verdict(report) {
  const sites = report.groups.filter((g) => g.id !== "crashtest");
  const admitted = sites.filter((g) => !g.intended && g.status !== "fail").map((g) => g.name);
  const refused = sites.filter((g) => g.intended && g.status === "ok").map((g) => g.name);
  const broken = report.groups.flatMap((g) => g.checks.filter((c) => c.status === "fail").map((c) => `${c.label} (${g.name.replace(/-/g, "‑")})`));
  const h = $("verdict");
  h.replaceChildren();
  if (broken.length) {
    h.append(el("span", { class: "no" }, `${broken.length} check${broken.length === 1 ? "" : "s"} failing: `), broken.slice(0, 2).join("; "), broken.length > 2 ? "…" : ".");
    return;
  }
  const names = admitted.length === 2 ? `${admitted[0]} and ${admitted[1]} are admitted` : `${admitted.join(", ")} ${admitted.length === 1 ? "is" : "are"} admitted`;
  h.append(report.status === "warn" ? "Everything is live, " : "Everything is live: ", el("em", {}, names), refused.length ? `; ${refused.join(", ")} ${refused.length === 1 ? "is" : "are"} refused, as designed.` : ".");
  if (report.status === "warn") h.append(" One thing needs a look soon.");
}

function authority(g) {
  $("authority").replaceChildren(el("h2", {}, `Issued by ${g.name}`), ...g.checks.map((c) => el("span", { class: c.status === "ok" ? "" : "bad", title: c.detail, icon: iconFor(c.status) }, link(c.evidence, c.label))));
}

let last = new Map(); // group id -> seal decision, to press only seals that changed
async function load() {
  const btn = $("again");
  btn.disabled = true;
  btn.textContent = "Checking…";
  $("passports").setAttribute("aria-busy", "true");
  try {
    const resp = await fetch("api/health", { cache: "no-store" });
    if (!resp.ok) throw new Error(`the check answered ${resp.status}`);
    const report = await resp.json();
    const sites = report.groups.filter((g) => g.id !== "crashtest");
    const next = new Map(sites.map((g) => [g.id, `${sealFor(g, report.generated_at).text}|${g.status}`]));
    $("passports").replaceChildren(...sites.map((g, i) => passport(g, i, last.get(g.id) !== next.get(g.id), report.generated_at)));
    last = next;
    authority(report.groups.find((g) => g.id === "crashtest"));
    verdict(report);
    $("checked").textContent = `Checked ${time(report.generated_at)} UTC, ${date(report.generated_at)}, from our server; results may be up to a minute old.`;
    $("error").hidden = true;
  } catch (error) {
    $("error").textContent = `The health check could not run (${error.message}). Try again in a moment.`;
    $("error").hidden = false;
    if (!last.size) $("verdict").textContent = "The health check could not run.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Check again";
    $("passports").setAttribute("aria-busy", "false");
  }
}

$("again").addEventListener("click", load);
load();
