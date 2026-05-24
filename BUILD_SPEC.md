# BUILD_SPEC — Recipe App ("recipes.tactag.app")

**Audience:** Cursor (implementer). This file is the single source of truth. Do not deviate without flagging.
**Owner:** T. Domain/DNS/hosting handled separately by owner — do NOT trigger a deploy; just produce deploy-ready config.

---

## 1. Purpose
Single-user web app to store recipes, import them from any URL, auto-format with light manual tweaks, convert units (imperial↔metric, °F↔°C) with **smart ingredient-aware weights**, scale servings, and cook from a phone with screen-awake + browser print.

Single user. No auth/login in v1 (the app is private behind an unguessable path or basic gate — see §9).

---

## 2. Stack (fixed)
- **Backend:** FastAPI + Uvicorn (Python 3.11+).
- **DB:** Postgres on Railway. Connection via `psycopg` v3 pool (already in `db.py`).
- **Parser:** `recipe-scrapers` (JSON-LD + 400+ sites) with manual-paste fallback.
- **Frontend:** Vanilla HTML/CSS/JS served as static files by FastAPI. No build step, no framework.
- **PWA:** service worker (offline cache) + Wake Lock API + `window.print()` with print stylesheet.
- **Deploy:** Railway. Provide `railway.json` + `Procfile`-style start command. Do not deploy.

**Hard constraints:** No Power Automate, no Microsoft Graph/Entra. No client-side framework. No localStorage/sessionStorage for primary data — Postgres is the store.

---

## 3. File responsibilities
```
recipes-app/
├── main.py            # FastAPI app, routes, static mount, lifespan (open/close pool, init_db)
├── db.py              # DONE — pool + schema + init_db()  [GROUND TRUTH, do not rewrite]
├── parser.py          # recipe-scrapers wrapper -> normalized Recipe dict; manual fallback
├── convert.py         # parse-time normalization of ingredient strings into base values
├── requirements.txt   # DONE [GROUND TRUTH]
├── data/
│   └── densities.json # shared density table (g per cup) — SINGLE SOURCE OF TRUTH
├── static/
│   ├── index.html     # SPA shell: list view, import view, edit view, cook view
│   ├── app.js         # routing (hash-based), API calls, render, edit/layout controls
│   ├── convert.js     # CLIENT-SIDE conversion + scaler engine (reads densities.json)
│   ├── style.css      # screen styles + @media print stylesheet
│   ├── sw.js          # service worker: cache shell + visited recipes for offline
│   └── manifest.json  # PWA install metadata
├── railway.json       # deploy config
└── README.md          # run locally + deploy notes
```

`db.py` and `requirements.txt` already exist and are correct. Treat as ground truth.

---

## 4. Data shapes

### Recipe (canonical object, stored + passed over API)
```json
{
  "id": 12,
  "title": "Banana Bread",
  "source_url": "https://example.com/banana-bread",
  "image_url": "https://.../img.jpg",
  "base_servings": 8,
  "prep_time": 15,
  "cook_time": 55,
  "total_time": 70,
  "unit_system": "imperial",
  "notes": "Family favorite.",
  "ingredients": [
    {
      "id": "ing_1",
      "raw": "1 1/2 cups all-purpose flour",
      "quantity": 1.5,
      "unit": "cup",
      "item": "all-purpose flour",
      "density_key": "flour_ap",
      "group": null
    }
  ],
  "instructions": [
    { "step": 1, "text": "Preheat oven to 350°F." }
  ],
  "layout": {
    "ingredient_groups": [],
    "hidden_ingredient_ids": [],
    "step_order": null
  }
}
```

**Field rules**
- `quantity`: float. Convert fractions ("1 1/2", "½") → 1.5. If unparseable, leave `quantity: null`, keep `raw`, mark `unit: null`.
- `unit`: one of the canonical unit tokens in §5, or `null` for countable items ("2 eggs").
- `density_key`: matched against `densities.json`; `null` if no match (then weight conversion is disabled for that line and we keep volume only).
- `group`: optional section header ("Dough", "Glaze") for layout. `null` = ungrouped.
- `layout`: holds April's tweaks. `step_order` is an array of step indices when reordered, else `null`.

---

## 5. Units (canonical tokens)
- Volume: `tsp, tbsp, cup, floz, ml, l`
- Weight: `oz, lb, g, kg`
- Temp: handled inline in instruction text (regex find °F/°C) and shown via a toggle, NOT stored per-field.
- Count: `null` unit (eggs, cloves) — never converted, only scaled.

Parser must map common spellings to these tokens (teaspoon→tsp, tablespoon→tbsp, gram/grams→g, ounce/oz→oz, etc.).

---

## 6. Conversion engine (`convert.js`) — client-side, instant

Pure functions, no DOM. Exported for app.js.

**Scaling:** `scale(quantity, baseServings, targetServings)` → `quantity * target / base`. Round display to a sensible fraction (nearest 1/8 for volumes, whole numbers for counts, 1g/1°). Counts (`unit: null`) scale and round to nearest whole or half.

**Imperial→Metric volume:** tsp=4.929ml, tbsp=14.787ml, cup=236.588ml, floz=29.574ml. Collapse to ml, promote to l at ≥1000ml.

**Imperial→Metric weight:** oz=28.3495g, lb=453.592g. Promote to kg at ≥1000g.

**Smart weight (volume→weight):** when target system is metric AND `density_key` exists in `densities.json`, convert volume→grams using `grams = (volume_in_cups) * density_g_per_cup`. This is the "1 cup flour ≈ 120g" feature. If no density_key, fall back to volume (ml).

**Temp:** F→C = `(f-32)*5/9`, round to nearest 1°. Detect in instruction text via regex `(\d{2,3})\s*°?\s*F`, replace inline when metric toggle is on. Keep original in a data attribute so toggling back is lossless.

**Metric→Imperial:** reverse of the above. Provide both directions.

`densities.json` shape:
```json
{ "flour_ap": 120, "sugar_white": 200, "sugar_brown": 220, "butter": 227, "milk": 240, "water": 237, "...": 0 }
```
Seed with ~30 common baking/cooking ingredients (g per cup). Document the unit in a `_meta` key.

---

## 7. Parser (`parser.py`)

```
parse_url(url: str) -> dict   # raises ParseError on failure
parse_manual(payload: dict) -> dict
```

- `parse_url`: use recipe-scrapers. Extract title, image, total/prep/cook time, yields→base_servings (parse leading integer), ingredients (raw strings), instructions (split into steps). Then call `convert.normalize_ingredient(raw)` per line to fill quantity/unit/item/density_key.
- On any scraper failure or empty ingredients → raise `ParseError` so the API returns 422 and the frontend shows the manual-paste form.
- `parse_manual`: accepts title + raw ingredient block (newline-separated) + raw steps block; runs the same normalization. This is the guaranteed fallback so April is never blocked by a site.
- `convert.normalize_ingredient(raw)` lives in `convert.py` (Python): regex parse "qty unit item", fraction handling, unit mapping, density_key matching against densities.json. Mirror the JS unit tokens exactly.

---

## 8. API contract (`main.py`)
All JSON. Prefix `/api`.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/recipes/parse | `{ "url": "..." }` | parsed Recipe (unsaved, no id) or 422 ParseError |
| POST | /api/recipes/manual | `{ "title","ingredients_raw","steps_raw" }` | parsed Recipe (unsaved) |
| POST | /api/recipes | Recipe (no id) | saved Recipe (with id) |
| GET | /api/recipes | — | `[{id,title,image_url,total_time}]` (list summary) |
| GET | /api/recipes/{id} | — | full Recipe |
| PUT | /api/recipes/{id} | full Recipe | updated Recipe |
| DELETE | /api/recipes/{id} | — | `{ "deleted": true }` |

Static: mount `static/` at `/`. `index.html` is the SPA entry. `data/densities.json` served at `/data/densities.json`.

Use Pydantic models for Recipe/Ingredient/Instruction validation. `updated_at` set to `now()` on every PUT.

---

## 9. Frontend (`app.js` + `index.html`)
Hash-based routing, four views:
1. **List** (`#/`) — cards of saved recipes, "Import" button, search box (client-side filter).
2. **Import** (`#/import`) — URL field → POST parse. On 422, swap to manual-paste form → POST manual. Show parsed result in the editor before saving.
3. **Edit** (`#/edit/:id` and post-import) — editable title/notes, ingredient list (edit qty/unit/item, group into sections, hide a line, drag to reorder steps), Save → POST/PUT.
4. **Cook** (`#/cook/:id`) — clean reading layout, big text, **servings stepper** (live rescale), **unit toggle** (imperial/metric, live), **Wake Lock** toggle ("Keep screen on"), **Print** button (`window.print()`).

Wake Lock: request on entering cook view if user enables it; re-acquire on `visibilitychange`. Handle unsupported browsers gracefully (hide the toggle).

**Auth gate (v1):** single shared passphrase checked server-side via a simple dependency on write routes, passphrase stored as Railway env var `APP_PASSPHRASE`. Read routes can stay open behind the unguessable domain, OR gate everything — owner to confirm. Default: gate write routes only.

---

## 10. PWA
- `manifest.json`: name "Recipes", standalone display, icons (placeholder paths, owner supplies icons).
- `sw.js`: cache app shell (html/js/css/densities) on install; runtime-cache visited recipe API responses (stale-while-revalidate) so a recipe opens offline mid-cook. Network-first for the recipe list.

---

## 11. Print stylesheet (`@media print`)
- Hide nav, buttons, steppers, toggles.
- Title, ingredients (current scaled+converted values as shown on screen), numbered steps, source URL footer.
- Single clean column, black on white, no images by default (toggle to include).

---

## 12. Acceptance criteria
1. Importing a JSON-LD recipe URL returns a fully populated editor (ingredients parsed with qty/unit).
2. A site that fails parsing falls back to manual paste without an error screen.
3. Servings stepper rescales all quantities live, counts stay whole.
4. Unit toggle flips volumes→ml/g (smart weight for known ingredients) and °F→°C in steps, and back losslessly.
5. Cook view keeps screen awake when enabled (supported browsers) and survives a tab refocus.
6. Print produces a clean one-column sheet reflecting current scale/units.
7. App opens a previously-viewed recipe with network off.
8. Data persists in Postgres across restarts; no localStorage used for recipe data.

---

## 13. Build order (do in this sequence, commit each)
1. `data/densities.json` (seed ~30 ingredients).
2. `convert.py` (normalize_ingredient + Python-side helpers) with a quick `__main__` self-test.
3. `parser.py` (+ a couple of sample URLs in a `__main__` smoke test).
4. `main.py` (routes, Pydantic models, static mount, lifespan calling `init_db`).
5. `convert.js` (mirror tokens; unit tests as console asserts).
6. `static/index.html` + `app.js` (views in order: list → import → edit → cook).
7. `style.css` incl. print stylesheet.
8. `sw.js` + `manifest.json`.
9. `railway.json` + `README.md`. STOP before deploy.

Flag any ambiguity against this spec rather than guessing.
