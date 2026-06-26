# Phase 4 — Python sidecars + Docker Compose

## services/bg_remover/ (port 8001)

FastAPI + `rembg` (u2net). [app.py](../../services/bg_remover/app.py):

- `POST /remove` (multipart field `image`) → transparent PNG. Validates the
  upload is a real image (400 otherwise); rembg + the u2net session load lazily
  and a model/inference failure degrades to **503** (the backend client then
  falls back to the original image).
- `GET /health` → `{ status, model }`.
- [Dockerfile](../../services/bg_remover/Dockerfile) on `python:3.11-slim`,
  pre-downloads u2net into the image so the first request isn't slow.
- pytest [tests/test_remove.py](../../services/bg_remover/tests/test_remove.py):
  health, non-image rejection, and a **round-trip** that asserts the cutout is
  RGBA with fully-transparent background pixels (`alpha extrema == (0, >0)`).
  Verified locally: **3 passed** (real u2net download + inference).

## services/pref_ranker/ (port 8002)

FastAPI + LightGBM `LGBMRanker`, per-profile model at `models/{profileId}.lgb`
(joblib bundle of ranker + derived stats). [app.py](../../services/pref_ranker/app.py),
features in [features.py](../../services/pref_ranker/features.py):

- `POST /score` `{ profile_id, candidates:[{item_ids,items}], context }` →
  `{ scores }`. Heuristic (context-fit) scores when no model exists yet.
- `POST /train` `{ profile_id, samples:[{items,context,label}] }` → trains and
  persists; needs ≥1 like and ≥1 dislike else `{ trained:false }`.
- `GET /health` → `{ status, models:{id:trained_at} }`.
- **Features per candidate** (the 6 in the spec): cosine similarity to the
  centroid of liked outfits, item co-occurrence frequency in liked outfits,
  formality match vs context, warmth match vs temperature, season-match boolean,
  novelty `1/(1+days_since_last_worn)`. **Outfit vector** = normalized concat of
  one-hot category + one-hot top-50 subcategory + primary RGB + formality +
  warmth.
- pytest [tests/test_pref.py](../../services/pref_ranker/tests/test_pref.py):
  health, heuristic score shape (winter outfit beats summer in a winter context),
  **train→score round-trip** (model persisted, `/health` lists it), and the
  insufficient-labels guard. Verified locally: **4 passed** (real LightGBM).

## Backend integration (made functional this phase)

`pref_client.score` now sends candidates enriched with each outfit's item
attributes; `pref_client.train(profileId, samples)` sends labeled samples the
controller assembles from `outfit_feedback` joined with item attributes (incl.
soft-deleted items). So suggest re-ranking and the feedback→train trigger
exercise the sidecar for real. Both remain best-effort — if `PREF_RANKER_URL` is
unreachable, suggest keeps Claude's order and the train trigger is a no-op.

## docker-compose.yml (repo root)

Services `backend` (3000 HTTP + 4000 WS), `bg_remover` (8001), `pref_ranker`
(8002) on one network; the backend reaches sidecars by service name (env
overrides force `http://bg_remover:8001` / `http://pref_ranker:8002`). Sidecars
have `/health` healthchecks; the backend `depends_on … condition:
service_healthy`. `./backend/data` is volume-mounted (SQLite + images) and a
named `pref_models` volume persists trained models. Backend secrets load from
`backend/.env` (gitignored); the host's win32 `node_modules` is excluded via
`.dockerignore` so the image builds linux-native `sqlite3`/`sharp`.

## Verifying (run on a Docker host)

Docker isn't available in this dev sandbox, so the compose YAML was
structure-validated only here. On a machine with Docker:

```
docker compose up --build
# in another shell:
curl localhost:3000/health     # {"status":"ok",...}
curl localhost:8001/health     # {"status":"ok","model":"u2net"}
curl localhost:8002/health     # {"status":"ok","models":{}}
```

For local dev **without** Docker, point `BG_REMOVER_URL` / `PREF_RANKER_URL` in
`backend/.env` at `http://localhost:8001` / `:8002` (or leave the compose
service-name defaults, in which case the backend uses its graceful fallbacks).
