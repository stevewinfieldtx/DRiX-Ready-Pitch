# Railway Deployment — DRiX Platform

End-to-end steps to get DRiX-Brain (HTTP service) and DRiX-Ready-Pitch running on Railway in the same project, with shared Postgres.

**Architecture recap:**
- **Brain** = deployed Express service. Owns Postgres schema. Exposes cache HTTP endpoints. Never in the slow path.
- **Pitch** = deployed Express service. Calls OpenRouter / Firecrawl directly with its own keys (slow ops, no bottleneck). Calls Brain over Railway's internal network for cache ops (fast).
- **Postgres** = Railway plugin. Brain owns the connection. Pitch never touches it directly.

---

## Step 1 — Push DRiX-Brain to GitHub

```powershell
cd C:\Users\SteveWinfiel_12vs805\Documents\DRiX-Brain
git init                       # if not already
git add .
git commit -m "Brain as HTTP service: cache endpoints + client sub-export"
git remote add origin https://github.com/stevewinfieldtx/DRiX-Brain.git
git branch -M main
git push -u origin main
git tag v0.2.0
git push --tags
```

If the repo already exists on GitHub, skip `git init` / `git remote add`. The important part is **tagging `v0.2.0`** — Pitch's `package.json` will pin to that tag.

## Step 2 — Update DRiX-Ready-Pitch's package.json

Edit `C:\Users\SteveWinfiel_12vs805\Documents\DRiX-Ready-Pitch\package.json`:

```json
"dependencies": {
  "dotenv": "^16.4.5",
  "express": "^4.21.2",
  "multer": "^1.4.5-lts.1",
  "drix-brain": "github:stevewinfieldtx/DRiX-Brain#v0.2.0"
}
```

Change just the `drix-brain` line — from `"file:../DRiX-Brain"` to `"github:stevewinfieldtx/DRiX-Brain#v0.2.0"`.

Then locally:

```powershell
cd C:\Users\SteveWinfiel_12vs805\Documents\DRiX-Ready-Pitch
del package-lock.json
rmdir /s /q node_modules
npm install
```

Verify it works locally first (`npm start` — Pitch on 3002, talks to Brain on 3001).

## Step 3 — Push DRiX-Ready-Pitch to GitHub

```powershell
cd C:\Users\SteveWinfiel_12vs805\Documents\DRiX-Ready-Pitch
git init                       # if needed
git add .
git commit -m "v0.2: brain-client HTTP, cached badge in GUI"
git remote add origin https://github.com/stevewinfieldtx/DRiX-Ready-Pitch.git
git branch -M main
git push -u origin main
```

## Step 4 — Railway: confirm/add services

Open Railway → your **DRiX-Brain** project (the one that's already running).

### 4a — Update the existing Brain service

If brain is already running but doesn't know about the new HTTP endpoints, it's running the old code. To pick up the new version:

- Railway service settings → check the "Source repo" is `stevewinfieldtx/DRiX-Brain`, branch `main`.
- Trigger a redeploy (push to main does this automatically).
- Verify env vars are set:
  - `DATABASE_URL` — auto-injected by Railway from the Postgres plugin
  - `PORT` — Railway sets this automatically
- After redeploy, hit `https://drix-brain.up.railway.app/healthz` (or whatever your Brain URL is). Should return `{"ok":true,"service":"drix-brain","db_configured":true,"cache_ready":true,...}`.

### 4b — Add the Pitch service to the same project

In the DRiX-Brain Railway project, click **+ New** → **GitHub repo** → `stevewinfieldtx/DRiX-Ready-Pitch` → main branch.

Railway auto-detects Node and runs `npm install && npm start`. Wait for the build to finish.

### 4c — Set Pitch's env vars in Railway

In Pitch's Variables tab:

| Variable | Value |
|---|---|
| `OPENROUTER_API_KEY` | (your OpenRouter key) |
| `OPENROUTER_MODEL_ID` | `anthropic/claude-sonnet-4.5` |
| `FIRECRAWL_API_KEY` | (your Firecrawl key, optional) |
| `BRAIN_URL` | `http://${{drix-brain.RAILWAY_PRIVATE_DOMAIN}}:3001` (Railway expands the reference automatically) |
| `BRAIN_TIMEOUT_MS` | `10000` |
| `PITCH_CRAWL_DEPTH_DEFAULT` | `3` |
| `PORT` | (leave unset — Railway sets it) |

**Do NOT set `DATABASE_URL` on Pitch.** Pitch doesn't touch Postgres directly — that's the whole point of brain owning it.

### 4d — Get Pitch's public URL

Railway → Pitch service → Settings → Networking → **Generate Domain**. You'll get something like `drix-ready-pitch-production.up.railway.app`. That's your public Pitch URL.

## Step 5 — Verify end-to-end

1. Open `https://YOUR-PITCH-URL/` in a browser. You should see the form.
2. Fill in a real customer URL and a real solution URL. Click Generate Pitch.
3. First run: takes 30-60s, badge says **Fresh**.
4. Run identical inputs again: should take <1s, badge says **✓ Cached just now (instant)**.
5. Tick **Force refresh (skip cache)** and submit again: takes 30-60s, badge says Fresh.

## Step 6 — Verify caches in Postgres (optional but reassuring)

Railway → Postgres plugin → Query tab:

```sql
SELECT url, byte_count, hit_count, updated_at FROM scrape_cache ORDER BY updated_at DESC LIMIT 10;
SELECT reseller_id, customer_url, solution_url, hit_count, created_at FROM pitch_cache ORDER BY created_at DESC LIMIT 10;
```

You should see rows from your test runs.

---

## Adding the next product (Campaign) later

When you build DRiX-Ready-Campaign, the deploy steps are identical to Step 2-5 above, just substituting `Campaign` for `Pitch`. Same Brain, same Postgres, same project.

If Campaign needs its own cache table (e.g. `campaign_cache`), add the schema to `DRiX-Brain/src/cache/schema.js`, tag a new brain version, redeploy brain. Campaign's package.json pins to the new tag. Pitch keeps its old tag — its behavior doesn't change.

---

## If something breaks

**Pitch can't reach Brain** — symptoms: `[brain] not reachable` in Pitch's logs. Fix:
- Check `BRAIN_URL` env var on Pitch matches Brain's actual internal domain
- Hit Brain's public URL `/healthz` from a browser — make sure Brain itself is up
- Make sure Brain's `PORT` (Railway-assigned) matches what you've put in BRAIN_URL — usually you don't specify the port and just use `http://${{drix-brain.RAILWAY_PRIVATE_DOMAIN}}`

**Brain says `cache_ready: false`** — fix:
- Brain isn't connected to Postgres. Check `DATABASE_URL` is set on Brain (Railway should auto-inject when Postgres plugin is in the same project).

**`npm install` fails on `drix-brain` GitHub URL** — fix:
- Make sure the tag `v0.2.0` exists on the Brain repo: `git tag` → should list it.
- If the repo is private, Railway needs access. Settings → GitHub → grant access to `stevewinfieldtx/DRiX-Brain`.

**Two identical queries don't hit cache** — fix:
- Check Pitch's response in browser DevTools. The first response should have `cached: false`. The second should have `cached: true`. If both say false, brain isn't being called correctly.
- Look at Brain's logs for any 500 errors on `/cache/pitch/store`.

---

## What changed from v0.1 → v0.2

- Brain is now an HTTP service, not just a Node library.
- Pitch installs Brain as a regular npm dep (`drix-brain`) and uses it for two things:
  - `require('drix-brain')` → local helpers (`callLLM`, `fetchAndStrip`) that run inside Pitch's process with Pitch's own API keys.
  - `require('drix-brain/client')` → HTTP client that calls Brain's deployed service for cache operations.
- Pitch no longer needs `DATABASE_URL`. Brain owns Postgres.
- Brain auto-creates the cache schema on first request.
- GUI shows a cache badge (Cached / Fresh) and supports "Force refresh" to bypass cache.
- Reseller-scoped pitch cache, globally-shared scrape cache.
