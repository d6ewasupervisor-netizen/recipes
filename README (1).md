# Recipes — recipes.tactag.app

Single-user recipe app: import from any URL, auto-format with light tweaks, smart unit
conversion (imperial↔metric with ingredient-aware weights), serving scaler, cook mode
with screen-awake + browser print. FastAPI + Postgres + vanilla JS PWA.

**Spec:** see `BUILD_SPEC.md` — it is the single source of truth. Build order in §13.

---

## Stack
- FastAPI + Uvicorn (Python 3.11+)
- Postgres (Railway) via psycopg v3 pool
- `recipe-scrapers` for URL import + manual-paste fallback
- Vanilla HTML/CSS/JS, no build step
- PWA: service worker (offline) + Wake Lock + `window.print()`

---

## Run locally
```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
export DATABASE_URL="postgresql://localhost/recipes"  # a local Postgres
export APP_PASSPHRASE="choose-a-passphrase"
uvicorn main:app --reload
# open http://127.0.0.1:8000
```

`init_db()` runs on startup (FastAPI lifespan) and creates the `recipes` table if absent.

---

## Deploy (Railway) — owner handles, do NOT auto-deploy
1. New Railway project → add **Postgres** plugin (injects `DATABASE_URL` automatically).
2. Set env var **`APP_PASSPHRASE`** (gate for write routes).
3. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Custom domain: point `recipes.tactag.app` (CNAME via Cloudflare) at the Railway service.
5. `railway.json` pins the build/start; confirm `$PORT` is honored.

**Note:** `DATABASE_URL` from Railway may start `postgres://`; `db.py` already rewrites it
to `postgresql://` for psycopg v3.

---

## Assets (already in `static/`)
- `icon-192.png`, `icon-512.png` — launcher (transparent)
- `icon-maskable-512.png` — Android safe-area
- `icon-launcher.svg` — editable source
- `icons.svg` — UI glyph sprite; use `<svg class="icon"><use href="/icons.svg#print"/></svg>`
- `manifest.json` — wired to the three launcher sizes

Palette: ink `#143036`, sage `#a9b9a6`, cream `#f5efe1`, mustard accent `#c8a24a`.

---

## Cursor kickoff prompt
> Implement this repo per `BUILD_SPEC.md`. Follow the build order in §13, one numbered
> step per commit. `db.py`, `requirements.txt`, and everything in `static/` (icons,
> manifest) are ground truth — do not rewrite them. Mirror the unit tokens between
> `convert.py` and `convert.js` exactly, with `data/densities.json` as the shared source.
> Stop before any deploy. Flag any ambiguity against the spec instead of guessing.

---

## Acceptance
See `BUILD_SPEC.md` §12. Key checks: URL import populates the editor; failed parse falls
back to manual paste; servings stepper rescales live; unit toggle is lossless; cook view
holds the screen awake; print yields a clean one-column sheet; recipes open offline;
data persists in Postgres (no localStorage for recipe data).
