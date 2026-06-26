# Phase 7 — Demo wiring

- [tools/seed_demo_wardrobe.js](../../tools/seed_demo_wardrobe.js) — seeds a "Demo"
  profile (linked to mirror id `demo-mirror`) with **32 items** from
  [tools/demo_assets/manifest.json](../../tools/demo_assets/manifest.json). Reuses
  the real upload pipeline (resize/thumb) with bg-removal/BLIP-2 in fast fallback;
  synthesizes color-swatch placeholders for any missing CC image. Idempotent
  (clears + reseeds). **Verified:** seeded 32 items.
- [tools/synthetic_feedback.js](../../tools/synthetic_feedback.js) — seeds **36**
  `synthetic=1` feedback rows across 6 weekly buckets, backdated, with acceptance
  rising after a training boundary; stamps `wardrobe_pref_models.first_trained_at`.
  Trains the real ranker too if `PREF_RANKER_URL` is set. **Verified:** 36 rows +
  trained-at boundary; the live metrics endpoint returns **0.5 acceptance before
  / 1.0 after** the boundary.
- [tools/acceptance_dashboard/index.html](../../tools/acceptance_dashboard/index.html)
  — self-contained admin page (React + **Recharts** via CDN) mounted by the
  backend at **`/admin/wardrobe`** (one additive `express.static` line in app.js).
  Plots weekly acceptance with a "model trained" reference line and before/after
  cards. Pass `?mid=demo-mirror`. **Verified:** route serves 200.
- [docs/wardrobe/demo_script.md](demo_script.md) — the 5-minute defense
  walkthrough, mapping each gesture/screen to presenter narration, with a
  gesture cheat-sheet and live-failure fallbacks.

## Run order

```
node tools/seed_demo_wardrobe.js
node tools/synthetic_feedback.js
# backend up, then open:
http://<host>:3000/admin/wardrobe/?mid=demo-mirror
```

## Only change to existing code

One additive static mount in [backend/src/app.js](../../backend/src/app.js)
(`/admin/wardrobe`). Everything else is new files under `tools/`.
