# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Hackathon judges and visitors** (Open Agentic Web Challenge, judging 11–18 Jan 2027): they open
  the tester and its pages to see whether the trust layer is real, live and checkable, usually
  once, without an account or an AI key.
- **Site authors and developers** on the open agentic web: they paste a network URL to see how its
  agents behave on a model, and read the scorecard and attestation.
- **Frank (the publisher/operator)**: checks before demos, recording and judging that every site,
  MCP server, signature and attestation is up and valid.
- **AI agents**, through the read-only MCP server and the public JSON APIs.

## Product Purpose

crash-test is the behaviour layer of *Trust Before Transaction*: it runs any published agent
network in the real, unmodified browser runtime on a fixed model, with stand-in site tools, and
reports what the agents do under injections, pressure, missing data, timed-out actions, partner
contact, private details, loops and key requests. It signs the result as an in-toto attestation
bound to the network hash, the site's declared actions and the model. Success: anyone can check a
claim about an agent's behaviour without trusting the publisher, and the project's own live pieces
can be shown to be up and valid at any moment.

## Positioning

Trust is a property of network × model, measured on strangers' sites as well as our own, and
signed in standard formats (in-toto, DSSE, JWS, RFC 9421). No model decides who is trusted: code
checks signatures and attestations. Honest about its own errors: coverage separate from score,
a two-judge panel, every non-pass read by hand before publishing.

## Operating Context

- Live on Cloudflare Workers: the tester (crashtest.frankmp12357.workers.dev, site + results API +
  `/mcp`), Charge (the submission), As Oy Koivurinne (simulated housing company + arbiter `/mcp`),
  Spot Deals (deliberately bad fixture).
- Attestations expire 30 days after issue and must be re-published before judging.
- A daily GitHub Action (`crash-test-watch.yml`) re-tests changed or stale networks.

## Capabilities and Constraints

- Health page (confirmed 18 Nov): public, **judges first**, also Frank's pre-demo check. Covers
  **our own sites and services only**: Charge, As Oy Koivurinne, Spot Deals, the tester, both MCP
  servers, the arbiter; up, signed, attested, expiry dates, peer-trust reports. The challenge's
  listed sites are not on it.
- Alerts: the page shows problems, and the **daily CI job also runs the health check** and fails
  when something is down or an attestation expires within 7 days.
- Spot Deals being refused and failing tests is its intended state, not an outage.
- Workers free tier; no secrets or private keys in the browser; read-only public endpoints.
- The tester's site is static HTML/CSS/JS bundled with esbuild, served by the Worker's assets.

## Evidence on Hand

Live attestations and scorecards (`site/attestations/`), FINDINGS.md (F1–F46), the public results
database (`/api/runs`), the v20 run on all seven networks (18 Nov). No testimonials, users or
uptime history exist; do not invent them.

## Product Principles

1. Show the evidence, not a claim: every green state links to the thing that proves it.
2. Name what isn't verified, and why, in plain words.
3. Intended failures (the bad fixture) are labelled as intended, never shown as outages.
4. Standards and plain checks over cleverness; nothing that needs a model to decide trust.

## Accessibility & Inclusion

Status never by colour alone (text labels with every state); keyboard reachable; readable at
mobile widths.
