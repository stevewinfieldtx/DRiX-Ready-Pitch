# DRiX Pitch — Intake Spec

Source-of-truth for what the intake form collects, what's required, and what the system does with each field.

**Product framing:** Pitch is account-level prep. The rep already knows the customer and has a meeting on the calendar. No strategy selection, no email composition, no buying-committee mapping.

---

## Field reference

| Field | Required | Type | Source | Notes |
|---|---|---|---|---|
| `RESELLER` | yes | inferred | user profile | Pulled from session after sign-in. Never typed. |
| `CPP` (Communication Personality Profile) | n/a for Pitch | inferred | user profile | Pitch does not generate emails — CPP is unused here. Campaign only. |
| `INDUSTRY` / `SUBINDUSTRY` | optional | dropdown | inferred from customer URL, user confirms | Taxonomy source set in user profile: NAICS / SIC / Salesforce default / HubSpot default / custom upload. AI pre-fills from scraped homepage; user can override. |
| `CUSTOMER_URL` | yes | text input + screenshot verify | typed | URL must resolve. UI shows a screenshot thumbnail of the rendered page so the rep can confirm the right page before running. |
| `CUSTOMER_BACKGROUND` | optional | open text | typed | Anything the rep knows that isn't on the public site. Stays in **reseller silo** — never enters the community tier. |
| `INTERVIEW_CUSTOMER` | optional | AI-conducted chat | conversational | AI asks the rep targeted questions about the customer. Transcript stays in reseller silo. |
| `SOLUTION_URL` | yes | text input + screenshot verify | typed | Same screenshot verify as customer URL. Crawl depth field next to it (default 3). |
| `SOLUTION_UPLOADS` | optional | file upload (pdf/docx/pptx) | uploaded | Up to 10 files, 25MB each. Extracted text feeds the LLM. Treated as **community-eligible** if marked public; otherwise reseller silo. |
| `SOLUTION_BACKGROUND` | optional | open text | typed | Free-form context about the solution. Reseller silo unless explicitly marked public. |
| `COMPETING_PRODUCT` | optional | text input | typed | When set, output includes a competitive section (their_strength, your_edge, landmine_question, if_they_say). When absent, no competitive output. Never invent competitors. |
| `INFORMATIONAL_INTERVIEW` | optional | AI-conducted chat | conversational | AI interviews the rep about the opportunity/solution at large. Reseller silo. |
| `TITLE` | optional | text input or dropdown | typed | Drives pain-frame selection in the prompt — NOT just word choice. CFO/CISO/CMO/etc. each invoke a different pain lens. |
| `INDIVIDUAL` | optional | structured (name/role/notes) | typed | Specific person the rep is meeting. Only field where the company NAME is used (for individual web/Apollo lookup if integrated). |
| `CRAWL_DEPTH` | optional | integer | defaulted to 3 | Applies to both CUSTOMER_URL and SOLUTION_URL by default — child folder levels to also fetch. |

---

## Data-isolation rules

Two tiers, by source:

**Community tier (TDE-wide, all DRiX customers benefit):**
- Anything scraped from the public web (customer URL, solution URL, their PDFs if marked public).
- Any material the customer themselves published.
- Public records.

**Reseller tier (one reseller company, all their reps share it):**
- Free-text background notes (CUSTOMER_BACKGROUND, SOLUTION_BACKGROUND).
- AI interview transcripts (INTERVIEW_CUSTOMER, INFORMATIONAL_INTERVIEW).
- Individual notes typed by the rep.
- Upload defaults — public/community only if explicitly flagged.

The reseller tier is the institutional-knowledge layer: senior rep notes train junior reps, and when a rep leaves their knowledge stays with the company. This is a real product benefit, not just data hygiene.

---

## Inference behavior

**Industry pre-fill from CUSTOMER_URL:** When the rep enters a customer URL, the system fetches the homepage, infers the industry, and pre-selects the dropdown. The rep clicks once to confirm or overrides. No company-name search — URL scrape only (URL-based inference is reliable; name-based inference is brittle).

**Screenshot thumbnail:** Both URL inputs render a small page-screenshot preview so the rep can verify the right page loaded. Catches typos and weird redirects before a run is spent.

---

## What Pitch deliberately does NOT collect

- `TARGET_PERSONA` / `RECIPIENT_ROLE` lists — Pitch is one-person prep, not orchestration. The persona IS the person in the meeting.
- `STRATEGY_SELECTION` — there is no strategy menu. The strategy is "win this meeting."
- `OUTREACH_CHANNEL` choices — no outreach output in Pitch. Campaign owns multi-channel.
- `EMAIL_TONE` / `EMAIL_CTA` controls — Pitch produces no emails.
- `PRICE` / `BUDGET` / `DISCOUNT` — the partner controls pricing. Pitch never quotes, anchors, ranges, or hints at price. The prompt is instructed to refuse this.

If a user starts asking for any of the above, route them to Campaign (or to the partner, for pricing).

---

## What Pitch outputs (so intake design stays aligned)

For every run, the output JSON includes:

1. `customer_summary` + `industry_inferred`
2. `pain_points[]` (3-5, each with evidence + severity)
3. `lead_with` (the one-sentence opener)
4. `talking_points[]` (3 capability-to-pain bullets)
5. `discovery_questions[]` (exactly 3, in the standard DRiX 3-stage shape: OPENING / DEEPENING / ADVANCEMENT, each with positive_responses and neutral_negative_responses where every next_step and pivot is the ACTUAL WORDS the rep says, not instructions)
6. `top_objection` (objection + the exact words the rep says back)
7. `competitive` — `null` UNLESS `COMPETING_PRODUCT` was provided, in which case: `{ competitor_name, their_strength, your_edge, landmine_question, if_they_say }`
8. `script_30s` (~75 words, title-aware tone, no price talk)
9. `next_move` — ONE sentence on the single most useful thing to do/say in the 24-48 hours after the meeting. NOT an email body, NOT a sequence. Email composition belongs to Campaign.
10. `confidence` (score + notes)
