# Phase 1 — Schema & image storage

All wardrobe tables are created idempotently by `initWardrobeSchema(db)` in
[backend/db/wardrobe.js](../../backend/db/wardrobe.js), invoked once from the
shared `dbPromise` init in
[backend/src/config/database.js](../../backend/src/config/database.js) (right
before it resolves the db). Conventions match the existing schema: snake_case,
`INTEGER PRIMARY KEY AUTOINCREMENT`, FKs `ON DELETE CASCADE`, JSON as TEXT,
integer booleans, `DATETIME DEFAULT CURRENT_TIMESTAMP`.

## Tables

- **wardrobe_items** — `id, profile_id (FK), image_filename, thumb_filename,
  nobg_filename, category, subcategory, primary_color, secondary_colors (TEXT
  json), pattern, fabric_guess, formality (1-5), warmth (1-5), seasons (TEXT
  json), tags (TEXT json), last_worn_at, created_at, deleted (int default 0)`.
  Soft delete via `deleted = 1`; all reads filter `deleted = 0`.
- **outfit_feedback** — `id, profile_id (FK), item_ids (TEXT json), context (TEXT
  json), rating ('up'|'down'), reasoning_shown (TEXT), synthetic (int default 0),
  created_at`.
- **render_cache** — `id, profile_id (FK), item_ids_key (sorted ids joined by
  '-'), body_photo_hash, render_filename, created_at`. Unique index on
  `(profile_id, item_ids_key, body_photo_hash)` so a re-render of the same outfit
  on the same body photo is a cache hit.
- **wardrobe_pref_models** — `profile_id (PK/FK), first_trained_at,
  last_trained_at`. Lets the metrics route report `modelTrainedAt` without
  calling the sidecar.

Indexes: `idx_wardrobe_items_profile(profile_id, deleted)`,
`idx_outfit_feedback_profile(profile_id)`, and the unique render-cache index.

## Body photo — decision

Stored as a **`body_photo_filename` column on `profiles`** (added via the same
idempotent `ALTER TABLE ... ADD COLUMN ... .catch(() => {})` pattern the existing
`face_filename` / `widgets_config` / `ai_settings` columns use). This is one
photo per profile, mirrors the existing `face_filename` model exactly, and the
ALTER is the project's established low-risk migration idiom — so a parallel
`body_photos` table would be unnecessary indirection. Chosen per the latitude
the spec gave ("a column on profiles **or** a parallel table — check the findings
and choose").

## Image storage layout (on disk, under backend/data/wardrobe/)

```
backend/data/wardrobe/<profileId>/<itemId>/original.jpg   # resized raw upload (≤1024px edge)
backend/data/wardrobe/<profileId>/<itemId>/nobg.png       # transparent cutout (imageUrl)
backend/data/wardrobe/<profileId>/<itemId>/thumb.jpg      # thumbnail (thumbnailUrl)
backend/data/wardrobe/<profileId>/body/base.jpg           # base body photo
backend/data/wardrobe/<profileId>/renders/<cacheKey>.jpg  # cached VTON renders
```

Served statically by `app.use("/wardrobe", express.static(.../data/wardrobe))`
in [backend/src/app.js](../../backend/src/app.js) — the exact mechanism faces use
(`/faces`). The DB stores filenames only; full `imageUrl`/`thumbnailUrl` are
built from the request host by `serializeItem(row, serverRoot)`.

Because `itemId` is auto-increment, the upload pipeline inserts an empty row
first (`createItemRow`) to learn the id, writes files under `<itemId>/`, then
fills filenames + attributes via `updateItem`.

## Data-access module

[backend/db/wardrobe.js](../../backend/db/wardrobe.js) exports typed
(JSDoc) helpers: item CRUD (`createItemRow`, `getItem`, `listItems`,
`updateItem`, `softDeleteItem`), body photo (`setBodyPhoto`,
`getBodyPhotoFilename`), feedback (`insertFeedback`, `listFeedback`,
`countFeedback`, `allFeedbackForMetrics`), render cache (`renderKey`,
`getCachedRender`, `insertRender`), pref-model meta (`getPrefModel`,
`markPrefModelTrained`), plus path helpers and `serializeItem`.

## Validation performed

A fresh in-memory DB: ran `initWardrobeSchema` **twice** (no throw → idempotent),
confirmed all four tables + the `body_photo_filename` column, round-tripped a
JSON-array attribute, verified the season filter matches `spring` but not
`summer`, verified render-cache dedupes `[3,1,2]` and `[1,2,3]` to one row, and
verified soft delete hides the row. Result: **PASS**.
