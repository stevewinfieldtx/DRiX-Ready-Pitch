// server.js — DRiX Pitch
// Standalone Express app. Consumes DRiX-Brain. No coupling to Campaign or any
// other product. Single endpoint: POST /api/pitch.
//
// Hard rule: this file does NOT import from any other DRiX product. The brain
// is the only shared surface. If a change in Campaign ever breaks Pitch, the
// only place that can happen is in DRiX-Brain — narrowing the blast radius.

require('dotenv').config();

const express = require('express');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');

const brain = require('drix-brain');           // local helpers (callLLM, fetchAndStrip) — run in this process
const brainClient = require('drix-brain/client'); // HTTP client — calls brain Railway service for cache/auth/TDE
const { PITCH_KIT_PROMPT, PITCH_EMAILS_PROMPT, PITCH_KIT_SCHEMA, PITCH_EMAILS_SCHEMA } = require('./prompts/pitch');

const app = express();
const PORT = process.env.PORT || 3002;
const CRAWL_DEPTH_DEFAULT = parseInt(process.env.PITCH_CRAWL_DEPTH_DEFAULT || '3', 10);

app.use(express.json({ limit: '10mb' }));
// Accept bare domains ("acme.com") and prepend https:// if missing. Defense in
// depth — the GUI also normalizes, but POSTs from curl/Invoke-RestMethod won't.
// Derive a stable reseller_id from the reseller_context. The pitch_cache is
// scoped per reseller — same inputs from different resellers DON'T share.
function getResellerId(rc) {
  if (!rc) return 'anonymous';
  const company = (rc.company || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const url     = (rc.company_url || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-');
  return company || url || 'anonymous';
}

// Brain reachability is cached for 60s. If brain is down we fail soft —
// app still works without cache. Brain owns the schema init; Pitch never
// touches Postgres directly.
let _brainReady = false;
let _brainCheckedAt = 0;
const BRAIN_CHECK_TTL_MS = 60 * 1000;
async function ensureCacheReady() {
  const now = Date.now();
  if (_brainReady && (now - _brainCheckedAt) < BRAIN_CHECK_TTL_MS) return true;
  try {
    const h = await brainClient.health();
    _brainReady = !!(h && h.cache_ready);
    _brainCheckedAt = now;
    if (!_brainReady) console.warn('[brain] reachable but cache not ready (db not configured?)');
    return _brainReady;
  } catch (e) {
    _brainReady = false;
    _brainCheckedAt = now;
    console.warn('[brain] not reachable — proceeding without cache:', e.message);
    return false;
  }
}

// Wrap fetchAndStrip with the scrape cache. URL-only key, GLOBAL across resellers.
// Cache lookups go through brain HTTP (fast). The fetch itself runs locally in
// Pitch's process using Pitch's own FIRECRAWL_API_KEY — never proxied through brain.
async function fetchAndStripCached(url) {
  const cacheReady = await ensureCacheReady();
  if (cacheReady) {
    try {
      const hit = await brainClient.cache.scrape.lookup(url);
      if (hit) {
        return {
          fetched: { url: hit.url, title: hit.title, description: hit.description, text: hit.text },
          cached: true,
          cached_at: hit.updated_at,
        };
      }
    } catch (e) { console.warn('[scrape_cache] lookup failed:', e.message); }
  }

  // Cache miss (or brain down). Fetch locally with Pitch's credentials.
  const fetched = await brain.fetchAndStrip(url);
  if (cacheReady) {
    const fetchedVia = (process.env.FIRECRAWL_API_KEY && fetched.text && fetched.text.length > 200) ? 'firecrawl' : 'fetch';
    brainClient.cache.scrape.store(url, fetched, fetchedVia).catch(e => console.warn('[scrape_cache] store failed:', e.message));
  }
  return { fetched, cached: false };
}

function normalizeUrl(u) {
  let s = String(u || '').trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  return s;
}


// Serve the GUI from public/index.html when the user hits "/" in a browser.
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 }
});

// ─── Health ─────────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    app: 'drix-pitch',
    version: '0.1.0',
    brain_loaded: typeof brain.callLLM === 'function',
    port: PORT
  });
});


// Scan a kit result for missing pivot/next_step fields in discovery_questions.
// Returns array of dotted-path strings of missing fields. Empty array = complete.
function findIncompleteFields(kit) {
  const missing = [];
  const qs = Array.isArray(kit?.discovery_questions) ? kit.discovery_questions : [];
  qs.forEach((q, i) => {
    const tag = q.stage || ('q' + (i+1));
    (q.positive_responses || []).forEach((r, j) => {
      if (!r.next_step) missing.push(tag + '.positive_responses[' + j + '].next_step');
    });
    (q.neutral_negative_responses || []).forEach((r, j) => {
      if (!r.pivot) missing.push(tag + '.neutral_negative_responses[' + j + '].pivot');
    });
  });
  return missing;
}

// Merge two kit results — prefer fields from `b` only where `a`'s field was empty.
// Used after a retry to take the complete fields from whichever call had them.
function mergeKitsPreferComplete(a, b) {
  const out = JSON.parse(JSON.stringify(a)); // deep clone
  const qsA = out.discovery_questions || [];
  const qsB = b?.discovery_questions || [];
  qsA.forEach((qa, i) => {
    const qb = qsB[i];
    if (!qb) return;
    (qa.positive_responses || []).forEach((ra, j) => {
      const rb = (qb.positive_responses || [])[j];
      if (rb && !ra.next_step && rb.next_step) ra.next_step = rb.next_step;
    });
    (qa.neutral_negative_responses || []).forEach((ra, j) => {
      const rb = (qb.neutral_negative_responses || [])[j];
      if (rb && !ra.pivot && rb.pivot) ra.pivot = rb.pivot;
    });
  });
  return out;
}

// ─── /api/pitch ─────────────────────────────────────────────────────────────
// Intake → fetch customer + solution → LLM → structured cheat sheet
//
// Body (JSON):
// {
//   customer: {
//     url: string,                      // REQUIRED
//     background?: string,              // private to reseller
//     interview_transcript?: string,    // private to reseller
//     individual?: { name?, role?, notes? }
//   },
//   solution: {
//     url: string,                      // REQUIRED
//     background?: string,
//     interview_transcript?: string,
//     uploads_summary?: string,
//     crawl_depth?: number,             // default 3
//     competing_product?: string        // optional — when set, output includes competitive section
//   },
//   title?: string,                     // optional contact title
//   industry?: string,                  // optional — AI infers from URL if omitted
//   reseller_context?: { company?, cpp_summary? }
// }
app.post('/api/pitch', async (req, res) => {
  const run_id = `pitch_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const t0 = Date.now();

  try {
    const { customer, solution, title, industry, reseller_context } = req.body || {};

    // Normalize URLs so callers can omit https://
    if (customer?.url) customer.url = normalizeUrl(customer.url);
    if (solution?.url) solution.url = normalizeUrl(solution.url);

    // ─── Validation ─────────────────────────────────────────────────────────
    if (!customer?.url) {
      return res.status(400).json({ ok: false, error: 'customer.url is required' });
    }
    if (!solution?.url) {
      return res.status(400).json({ ok: false, error: 'solution.url is required' });
    }

    const crawlDepth = Number.isInteger(solution.crawl_depth)
      ? solution.crawl_depth
      : CRAWL_DEPTH_DEFAULT;

    // ─── Fetch both URLs in parallel ───────────────────────────────────────
    // NOTE: crawl_depth is captured in the payload but the current
    // brain.fetchAndStrip only fetches the root URL. Multi-level crawl is a
    // brain enhancement tracked in DRiX-Brain/MANIFEST.md.
    console.log(`[${run_id}] fetching customer + solution URLs (crawl_depth=${crawlDepth}, brain ignores depth for now)`);
    const [customerResult, solutionResult] = await Promise.allSettled([
      fetchAndStripCached(customer.url),
      fetchAndStripCached(solution.url)
    ]);

    if (customerResult.status === 'rejected') {
      return res.status(502).json({
        ok: false, run_id,
        error: `Failed to fetch customer URL: ${customerResult.reason?.message || 'unknown'}`
      });
    }
    if (solutionResult.status === 'rejected') {
      return res.status(502).json({
        ok: false, run_id,
        error: `Failed to fetch solution URL: ${solutionResult.reason?.message || 'unknown'}`
      });
    }
    const customerPage = { value: customerResult.value.fetched };
    const solutionPage = { value: solutionResult.value.fetched };
    const scrapeFromCache = { customer: customerResult.value.cached, solution: solutionResult.value.cached };
    if (scrapeFromCache.customer) console.log(`[${run_id}] scrape_cache HIT customer`);
    if (scrapeFromCache.solution) console.log(`[${run_id}] scrape_cache HIT solution`);

    // ─── Build the LLM payload ─────────────────────────────────────────────
    const llmPayload = {
      customer: {
        url: customer.url,
        scraped_title: customerPage.value.title,
        scraped_description: customerPage.value.description,
        scraped_content: customerPage.value.text,
        industry: industry || null,
        background: customer.background || null,
        interview_transcript: customer.interview_transcript || null,
        individual: customer.individual || null
      },
      solution: {
        url: solution.url,
        scraped_title: solutionPage.value.title,
        scraped_description: solutionPage.value.description,
        scraped_content: solutionPage.value.text,
        background: solution.background || null,
        interview_transcript: solution.interview_transcript || null,
        uploads_summary: solution.uploads_summary || null,
        competing_product: solution.competing_product || null
      },
      title: title || null,
      reseller_context: reseller_context || null
    };

    // ─── Pitch cache lookup (reseller-scoped, via brain HTTP) ─────────────
    const resellerId = getResellerId(reseller_context);
    const forceRefresh = !!req.body?.force_refresh;
    let cachedHit = null;
    if (!forceRefresh) {
      try {
        const cacheReady = await ensureCacheReady();
        if (cacheReady) {
          cachedHit = await brainClient.cache.pitch.lookup(llmPayload, resellerId);
        }
      } catch (e) { console.warn(`[${run_id}] pitch_cache lookup failed:`, e.message); }
    }
    if (cachedHit) {
      console.log(`[${run_id}] pitch_cache HIT — age ${cachedHit.age_seconds}s`);
      return res.json({
        ok: true,
        run_id,
        elapsed_ms: Date.now() - t0,
        cached: true,
        cached_at: cachedHit.created_at,
        cached_age_seconds: cachedHit.age_seconds,
        reseller_id: resellerId,
        inputs_echo: {
          customer_url: customer.url,
          solution_url: solution.url,
          title: title || null,
          industry_provided: industry || null,
          crawl_depth: crawlDepth,
          competing_product: solution.competing_product || null,
          scrape_from_cache: scrapeFromCache,
        },
        pitch: cachedHit.result,
      });
    }

    // ─── Call the brain — TWO PARALLEL LLM CALLS ──────────────────────────
    // Kit and emails are independent products consumed by the same UI. Running
    // them in parallel halves wall-clock vs sequential, and giving each its
    // own focused prompt eliminates the token-pressure that was causing the
    // LLM to drop pivot text in nested arrays.
    console.log(`[${run_id}] calling LLM (kit + emails in parallel)`);
    const payloadStr = JSON.stringify(llmPayload);
    const [kitSettled, emailsSettled] = await Promise.allSettled([
      brain.callLLM(PITCH_KIT_PROMPT,    payloadStr, { maxTokens: 7000, temperature: 0.2, retries: 1, responseSchema: PITCH_KIT_SCHEMA }),
      brain.callLLM(PITCH_EMAILS_PROMPT, payloadStr, { maxTokens: 5000, temperature: 0.5, retries: 1, responseSchema: PITCH_EMAILS_SCHEMA }),
    ]);

    if (kitSettled.status === 'rejected') {
      console.error(`[${run_id}] KIT call failed:`, kitSettled.reason?.message);
      return res.status(502).json({ ok: false, run_id, error: 'Kit generation failed: ' + (kitSettled.reason?.message || 'unknown') });
    }
    let kit = kitSettled.value;

    // RETRY-ON-INCOMPLETE: Sonnet sometimes drops nested pivot/next_step fields.
    // If detected, fire one targeted retry and merge — take the populated field
    // from whichever attempt had it. Only retries the kit (emails are separate).
    const initialMissing = findIncompleteFields(kit);
    if (initialMissing.length > 0) {
      console.warn(`[${run_id}] kit had ${initialMissing.length} missing fields, retrying once...`);
      try {
        const kitRetry = await brain.callLLM(PITCH_KIT_PROMPT, payloadStr, { maxTokens: 7000, temperature: 0.2, retries: 0, responseSchema: PITCH_KIT_SCHEMA });
        const merged = mergeKitsPreferComplete(kit, kitRetry);
        const stillMissing = findIncompleteFields(merged);
        if (stillMissing.length < initialMissing.length) {
          console.log(`[${run_id}] retry filled ${initialMissing.length - stillMissing.length} of ${initialMissing.length} missing fields`);
          kit = merged;
        }
      } catch (e) {
        console.warn(`[${run_id}] kit retry failed (keeping original):`, e.message);
      }
    }

    // Emails are best-effort — if they fail we still return the kit with a warning,
    // so the rep at least gets meeting prep.
    let emails = null;
    let emailsError = null;
    if (emailsSettled.status === 'fulfilled') {
      emails = emailsSettled.value;
    } else {
      emailsError = emailsSettled.reason?.message || 'unknown';
      console.warn(`[${run_id}] EMAILS call failed (kit still returned):`, emailsError);
    }

    // Merge: kit is the base, emails get spliced in.
    const result = { ...kit };
    if (emails && Array.isArray(emails.email_drip)) {
      result.email_drip = emails.email_drip;
      if (emails.confidence_note) result.email_confidence_note = emails.confidence_note;
    } else if (emailsError) {
      result._emails_error = emailsError;
    }

    // Required output fields. discovery_questions is required; competitive is
    // conditional on solution.competing_product being provided.
    const missing = [];
    if (!Array.isArray(result?.pain_points) || result.pain_points.length === 0) missing.push('pain_points');
    if (!result?.lead_with) missing.push('lead_with');
    if (!Array.isArray(result?.discovery_questions) || result.discovery_questions.length < 3) missing.push('discovery_questions (need 3)');
    else {
      const incomplete = [];
      result.discovery_questions.forEach((q, i) => {
        const stage = q.stage || ('q' + (i+1));
        if (!Array.isArray(q.positive_responses) || q.positive_responses.length === 0) incomplete.push(stage + '.positive_responses');
        if (!Array.isArray(q.neutral_negative_responses) || q.neutral_negative_responses.length === 0) incomplete.push(stage + '.neutral_negative_responses');
        // Flag empty next_step / pivot text — common LLM laziness
        (q.positive_responses || []).forEach((r, j) => { if (!r.next_step) incomplete.push(stage + '.positive_responses[' + j + '].next_step'); });
        (q.neutral_negative_responses || []).forEach((r, j) => { if (!r.pivot) incomplete.push(stage + '.neutral_negative_responses[' + j + '].pivot'); });
      });
      if (incomplete.length) {
        console.warn(`[${run_id}] discovery_questions incomplete: ` + incomplete.join(', '));
        // Soft warning, not a hard fail — surface in response so the UI can flag it
        result._incomplete_discovery = incomplete;
      }
    }
    if (!result?.top_objection) missing.push('top_objection');
    if (!result?.script_30s) missing.push('script_30s');
    if (!Array.isArray(result?.email_drip) || result.email_drip.length < 5) missing.push('email_drip (need 5)');
    else {
      // Flag emails missing subject or body — common LLM laziness on the last email
      const emailGaps = [];
      result.email_drip.forEach((em, i) => {
        if (!em.subject) emailGaps.push('email[' + i + '].subject');
        if (!em.body) emailGaps.push('email[' + i + '].body');
      });
      if (emailGaps.length) {
        console.warn(`[${run_id}] email_drip incomplete: ` + emailGaps.join(', '));
        result._incomplete_emails = emailGaps;
      }
    }
    if (!result?.next_move) missing.push('next_move');

    if (missing.length) {
      console.warn(`[${run_id}] LLM returned incomplete result — missing: ${missing.join(', ')}`);
      return res.status(502).json({
        ok: false,
        run_id,
        error: `LLM returned incomplete pitch (missing: ${missing.join(', ')})`,
        raw: result
      });
    }

    // Drop the schema-helper key if the LLM echoed it.
    if (result._competitive_when_provided !== undefined) delete result._competitive_when_provided;

    // If no competing_product was provided, force competitive to null so callers
    // can rely on the contract.
    if (!solution.competing_product) result.competitive = null;

    const ms = Date.now() - t0;
    const compFlag = result.competitive ? 'yes' : 'no';
    const conf = result.confidence?.score ?? '?';
    console.log(`[${run_id}] OK in ${ms}ms — ${result.pain_points.length} pains, ${result.discovery_questions.length} qs, ${(result.email_drip||[]).length} emails, competitive=${compFlag}, confidence=${conf}`);

    // Store in pitch_cache via brain HTTP. Skip when result is flagged incomplete.
    const isComplete = !result._incomplete_discovery && !result._incomplete_emails && !result._emails_error;
    if (isComplete) {
      try {
        const cacheReady = await ensureCacheReady();
        if (cacheReady) {
          await brainClient.cache.pitch.store(llmPayload, resellerId, result);
          console.log(`[${run_id}] pitch_cache STORED for reseller=${resellerId}`);
        }
      } catch (e) { console.warn(`[${run_id}] pitch_cache store failed:`, e.message); }
    } else {
      console.log(`[${run_id}] not caching — result flagged incomplete`);
    }

    res.json({
      ok: true,
      run_id,
      elapsed_ms: ms,
      cached: false,
      reseller_id: resellerId,
      inputs_echo: {
        customer_url: customer.url,
        solution_url: solution.url,
        title: title || null,
        industry_provided: industry || null,
        crawl_depth: crawlDepth,
        competing_product: solution.competing_product || null,
        scrape_from_cache: scrapeFromCache,
      },
      pitch: result
    });
  } catch (err) {
    console.error(`[${run_id}] ERROR:`, err.message);
    res.status(500).json({ ok: false, run_id, error: err.message });
  }
});

// ─── Solution document upload (optional, additive) ─────────────────────────
// Pre-extracts text from a PDF/docx/pptx so the rep can attach supporting
// material. Returned text is meant to be POSTed back as solution.uploads_summary.
// Kept thin — heavy ingestion belongs in the brain or in TDE.
app.post('/api/pitch/upload-solution-doc', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
  // Defer real extraction to brain or TDE in v0.2. For now, return a placeholder
  // confirming receipt so the UI flow can be built.
  res.json({
    ok: true,
    filename: req.file.originalname,
    bytes: req.file.size,
    note: 'v0.1: file received but text extraction is stubbed. Wire to brain ingestor in v0.2.'
  });
});

// "/" is now served by express.static above (public/index.html).
// If public/ is missing, browser will get a 404; api/* still works.

app.listen(PORT, () => {
  console.log(`[drix-pitch] listening on http://localhost:${PORT}`);
  console.log(`[drix-pitch] brain loaded: ${typeof brain.callLLM === 'function'}`);
});
