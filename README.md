# DRiX Pitch

Account-level sales prep. ONE customer, ONE meeting, ONE pitch.

Pitch is the simpler of the two ReadyLead products. It does NOT generate leads, NOT pick strategies, NOT write emails, NOT map buying committees. It assumes the rep already knows who they're meeting and just needs ammunition for one conversation: pain points, lead-with line, talking points, top objection, 30-second script.

**Status: v0.1 scaffold.** Single endpoint working against the brain. No UI yet — UI is the next step once the output format is validated.

---

## What's here

```
DRiX-Ready-Pitch/
├── package.json              Depends on drix-brain via file:../DRiX-Brain
├── .env.example
├── .gitignore
├── README.md                 You are here
├── server.js                 Express app, POST /api/pitch
├── prompts/
│   └── pitch.js              The core IP: system prompt + output schema
└── docs/
    └── INTAKE_SPEC.md        What the form collects, who owns what, data tiers
```

---

## Quick start

```bash
cd C:\Users\SteveWinfiel_12vs805\Documents\DRiX-Ready-Pitch
npm install
cp .env.example .env       # fill in OPENROUTER_API_KEY, DATABASE_URL
npm start                  # listens on http://localhost:3002
```

Test the endpoint:

```bash
curl -X POST http://localhost:3002/api/pitch \
  -H "Content-Type: application/json" \
  -d '{
    "customer": { "url": "https://example-law-firm.com" },
    "solution": { "url": "https://www.bitdefender.com/business/" },
    "title": "IT Manager"
  }'
```

---

## Architectural rules (these are load-bearing — do not violate)

1. **No imports from sibling DRiX products.** Pitch does not `require()` Campaign, Mentor Match, or anything in `DRiX-Ready-Leads-v2`. The brain is the only shared surface.
2. **No product-specific prompts in the brain.** The Pitch system prompt lives here, in `prompts/pitch.js`. It is Pitch's IP.
3. **Reseller silo is enforced at the brain DB layer, not here.** Don't add silo logic to this app — that's a brain concern.
4. **CPP is read-only context for Campaign emails. Pitch ignores it** — there are no emails in Pitch.

If a "simple change" in Pitch starts breaking other products, the leak is in the brain. That's where to debug.

---

## Versus Campaign (so it's clear)

| | Pitch | Campaign |
|---|---|---|
| Customer known? | yes, named, with URL | no — market segment |
| Strategy menu? | no | yes |
| Decision-maker hunt? | no | yes (Apollo etc.) |
| Output format | meeting cheat sheet | strategies + personas + emails + (future) social posts |
| Uses CPP? | no | yes (email tone) |
| Typical session | minutes before a call | days/weeks of campaign prep |
| Pricing posture | per-pitch or low subscription | annual seat, account-based |

---

## What's NOT built yet

- **Intake UI.** Backend works; no form yet.
- **Multi-level crawl.** `solution.crawl_depth` is captured in the payload but the current `brain.fetchAndStrip` only fetches the root URL. Brain enhancement tracked separately.
- **Document text extraction.** `/api/pitch/upload-solution-doc` accepts files but returns a stub. PDF/docx/pptx extraction belongs in the brain (or in TDE), not duplicated per product.
- **Auth + entitlements.** Anyone can hit `/api/pitch` right now. Wire to `brain.auth` / `brain.entitlements` once those exist.
- **Run history persistence.** Each run currently logs and returns; nothing is saved to the DB yet.
- **Screenshot thumbnail verify** on URL inputs — needs Firecrawl screenshot mode, doable but not built.

---

## Related

- `..\DRiX-Brain\` — shared core. Required dependency.
- `..\DRiX-Ready-Leads-v2\` — original monorepo. Untouched. Pitch does not import from it.
# DRiX-Ready-Pitch
