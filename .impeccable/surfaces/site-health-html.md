---
version: 1
slug: "site-health-html"
primary_target: "site/health.html"
related_targets: ["site/src/health.js","worker/src/health.js"]
---

# Surface: /health (site/health.html)

Mode: operate. Audience: hackathon judges first (one visit, no account), then Frank before demos and judging.
Job: see in seconds that every live piece of Trust Before Transaction is up and valid, and why; open the proof behind any claim.
Content: GET /api/health (worker/src/health.js): sites Charge, As Oy Koivurinne, Spot Deals (intended refusal), tester services.
Constraints: Spot Deals' refusal is shown as a feature, never hidden; meaning first, hashes and key ids on demand; not a generic uptime board; load + "Check again" (server caches 60 s); linked from tester nav, main README, Charge footer.

## Direction contract

THESIS: Each agent network carries a passport: identity, visas with dates, and the arbiter's entry stamp. Refuses the category default of rows of green dots that only say "up".

OWN-WORLD: The tester's world: near-black green ground (#05100c), card #0b1914, hairline #1d3a2e, ink #eaf5ef, muted #8fa89e, green #3ddc97 for valid, red #ff5c7a for refused, amber #f5b942 for expiring. Passport pages are tinted panels with faint ruled lines; visas are bordered boxes with dated validity in tabular mono; stamps are round double-ruled seals.

STORY: The visitor reads the one-line verdict, sees two pages stamped ADMITTED and one stamped ENTRY REFUSED (intended), understands that a domain signs, a tester vouches and code decides, and opens a visa's proof link if they want the evidence.

FIRST VIEWPORT: Tester top bar with Health active. Verdict sentence left, check time and "Check again" right. Three passport pages side by side at equal width, each: name and domain, visa for identity, visa for behaviour (score, model, valid until, days left), one extra visa (partner card or arbiter), seal in the lower corner. Below, a single authority strip for the tester's services.

FORM: Credentials passport, position 4 on the ordered list (bolder hand), seed: seed:f9d4f40b0ee0950f.

SIGNATURE: The seals press in once, in order, when results arrive (scale and blur settling, ease-out); "Check again" re-presses only seals whose state changed.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
