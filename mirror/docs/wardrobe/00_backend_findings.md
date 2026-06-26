# Phase 0 — Backend findings

Read of the real backend before writing any wardrobe code. Where my prompt's
"Context" section and the actual code disagree, **the code is documented here as
truth** and the disagreements are called out in the last section.

## 1. Stack & layout (the prompt called it a generic "Node.js backend")

- The backend is **Express 4** (CommonJS, plain JavaScript), not bare Node http.
  Layered as `routes/ → controllers/ → services/ → config/database.js`.
- Entry: [backend/server.js](../../backend/server.js) → builds the app in
  [backend/src/app.js](../../backend/src/app.js), listens on `PORT` (default
  **3000**) bound to `0.0.0.0`. It also starts a second WebSocket server,
  `mirrorSync`, on `WS_PORT` (default **4000**).
- All HTTP routes are mounted under **`/api`** (e.g. `/api/profiles`,
  `/api/mirrors`, `/api/auth`). New wardrobe routes mount under `/api` too.
- `express.json()` and open `cors()` are already applied globally.

## 2. Auth middleware to reuse

- File: [backend/src/middleware/auth.js](../../backend/src/middleware/auth.js),
  export name **`authenticate`** (`const { authenticate } = require("../middleware/auth")`).
- It validates a `Bearer <jwt>` from the `Authorization` header using
  `process.env.JWT_SECRET` and attaches the decoded payload to **`req.account`**:
  `{ accountId, householdId, email, iat, exp }`.
- There is **one login per household account**, not per profile. Login/register
  live in `routes/auth.js` → `authController` → `authService`. `POST /api/auth/login`
  returns `{ token, accountId, householdId, email }`.

### Household-scoping guard (copy this exact pattern on every wardrobe route)

Controllers load the profile, then compare household ids:

```js
const profile = await profileService.getProfile(Number(req.params.id));
if (profile.household_id !== req.account.householdId) {
  return res.status(403).json({ error: "Forbidden" });
}
```

For wardrobe routes the path param is `:profileId`; the rule is identical —
fetch the profile, 403 unless `profile.household_id === req.account.householdId`.
This is what makes a profile from another household return **403**.

## 3. Database handle & schema conventions

- Module: [backend/src/config/database.js](../../backend/src/config/database.js),
  export **`getDb()`** → returns a memoized promise of an open `sqlite` (the
  promise wrapper over `sqlite3`) connection. Usage: `const db = await getDb();`
  then `db.run / db.get / db.all / db.exec`.
- DB file: `backend/data/smart_mirror.db` (the whole `backend/data/` dir is
  gitignored). `PRAGMA foreign_keys = ON` and WAL are set.
- **Schema conventions (confirmed against existing tables):**
  - `snake_case` column names.
  - Primary keys: `id INTEGER PRIMARY KEY AUTOINCREMENT`.
  - Foreign keys: `FOREIGN KEY (x_id) REFERENCES y(id) ON DELETE CASCADE`.
  - Timestamps: `created_at DATETIME DEFAULT CURRENT_TIMESTAMP` (string ISO-ish).
  - **JSON is stored as TEXT** via `JSON.stringify(...)` and read with
    `JSON.parse(...)` (e.g. `profiles.face_filenames`, `widgets_config`,
    `ai_settings`; `security_alerts` etc.). No JSON column type used.
  - **Booleans are integers** — there is no BOOLEAN column type; flags are
    surfaced as `CASE WHEN ... THEN 1 ELSE 0` and consumed as `!!value`.
    New "deleted"/"synthetic" columns will be `INTEGER NOT NULL DEFAULT 0`.
  - Tables are created with `CREATE TABLE IF NOT EXISTS` inside the single
    `dbPromise` init block; **idempotent column adds** use
    `db.run("ALTER TABLE ... ADD COLUMN ...").catch(() => {})`. I will add
    wardrobe tables the same way (idempotent on existing DBs, clean on fresh).
- **`profiles` table** columns: `id, household_id, name, email, google_sub,
  mirror_id, face_filename, face_filenames (TEXT json), widgets_config (TEXT
  json), ai_settings (TEXT json), created_at`. There is **no location/lat/lng**
  column on profiles (relevant for the weather/context route — see §7).

## 4. Face upload + static-serve pattern (template for wardrobe images)

- **Upload** ([backend/src/routes/profiles.js](../../backend/src/routes/profiles.js)):
  `multer.diskStorage` writing to `backend/data/faces` (created with
  `fs.mkdirSync(dir, { recursive: true })`), filename
  `profile_<id>_<Date.now()>_<rand>.jpg`. Routes use
  `upload.single("face")` / `upload.array("faces", 24)` **after** `authenticate`.
- The controller stores **only the filename** in the DB
  (`UPDATE profiles SET face_filename = ?`), not a URL or bytes.
- **Static serve** ([backend/src/app.js](../../backend/src/app.js)):
  `app.use("/faces", express.static(path.join(__dirname, "../data/faces")))`.
  (`../data` because `app.js` lives in `src/`.) Same idea for alert snapshots at
  `/alert-snapshots`.
- **URL derivation:** the backend never stores absolute URLs. The full image URL
  is built client-side as `<API host>/faces/<filename>`. For wardrobe I will
  store filenames and serve a new static mount (e.g. `/wardrobe`), and build the
  `imageUrl`/`thumbnailUrl` in the route response from the request host
  (`req.protocol` + `req.get('host')`) so it matches the LAN-IP behavior the
  mirror/phone already rely on.

## 5. How the mirror authenticates to the backend  ⚠️ important

This is the biggest gap between the prompt and reality, and it decides how the
wardrobe widget calls the API.

- There are **two distinct "mirror id" concepts** — the prompt conflated them:
  1. **`mirror_id` (a client-generated UUID)** — `backendApi.getMirrorId()`
     does `crypto.randomUUID()` once and persists it in `localStorage`
     (`smartMirrorId`). This UUID is what `profiles.mirror_id` and
     `active_mirror_users.mirror_id` store, and what the mirror UI polls with.
     **It is not a public key.**
  2. **The pairing public key / `device_token`** — a separate X25519 key + token
     established during QR/BLE pairing and stored in the `mirrors` table
     (`mirror_id` PK there is the public key, plus `device_token`,
     `phone_public_key`). This belongs to the encrypted `sync/` layer and is
     **not** used by the HTTP widget flow.
- **The mirror display holds no JWT during normal operation.** It runs in a
  public/guest mode and reads everything through unauthenticated, mirror-id-keyed
  endpoints under `/api/mirrors/*` and `/api/mirror/*`:
  - `GET /api/mirrors/active-user?mid=<mirrorId>` → the active profile
    (`{ profile: { id, name, settings, ... } }`). **This is the active-profile
    mechanism Phase 6 must reuse to learn `profileId`.**
  - `GET /api/mirrors/gmail/messages?mid=...`, `/spotify/player?mid=...`, etc.
  - `backendApi` *can* store a JWT (`login()` writes `mirrorBackendToken`), but
    the steady-state mirror flow does not log in — the phone (Flutter) holds the
    JWT, pairs, and sets the active user.
- **Existing precedent:** Gmail and Spotify each expose **both** an
  authenticated per-profile route set (`/api/profiles/:id/gmail/...`, used by the
  phone) **and** a public mirror-scoped route set (`/api/mirrors/gmail/...?mid=`,
  used by the mirror widget). The wardrobe feature has the same two consumers
  (Flutter app with a JWT; mirror widget with only a `mirrorId`), so it faces the
  same fork. **See the open decision in §9.**

## 6. Widget registration mechanism

- Registry: [src/data/apps.js](../../src/data/apps.js) — an exported `apps` array
  of `{ id, name, description, componentPath, enabled, defaultPosition,
  defaultSize, settings, isBackgroundService? }`. Helpers: `getEnabledApps()`,
  `getAppSettings(id)`, `saveAppSettings`, `toggleAppEnabled` (all
  localStorage-backed under `smartMirrorSettings`).
- `componentPath` is a string resolved to a component under `src/apps/` (e.g.
  `WeatherApp`, `DateTimeApp`). Widgets are React function components rendered
  inside draggable/resizable wrappers (`DraggableApp.jsx`). The mirror page is
  [src/pages/SmartMirror.jsx](../../src/pages/SmartMirror.jsx) (to confirm the
  exact component-resolution map when building Phase 6).
- Per-profile widget visibility also comes from the backend
  (`profiles.widgets_config`, surfaced via `active-user`). The Wardrobe widget
  registers here the same way and will key off the active profile.

## 7. Context / weather data

- Weather today is a **client-side** widget ([src/apps/WeatherApp.jsx](../../src/apps/WeatherApp.jsx))
  with a default location string `'Istanbul'`; there is **no backend weather
  endpoint** and **no per-profile lat/lng** stored. So the new
  `GET /profiles/:id/context` route is genuinely new: it will use
  `OWM_API_KEY` with `HOME_LAT`/`HOME_LNG` env fallbacks (documented), since
  profiles carry no coordinates.

## 8. Gesture pipeline  ⚠️ important — there is NO gesture MLP

- The "gesture MLP (likely Python)" the prompt assumes **does not exist**. There
  is no Python ML, no TF.js/ONNX model, no discrete gesture classifier, and no
  gesture-class training pipeline anywhere in the repo (`provisioning/ble-setup.py`
  is the only `.py` file, unrelated).
- Gesture input is **MediaPipe Hands + geometric heuristics**, computed live in
  [src/components/HandTrackingService.jsx](../../src/components/HandTrackingService.jsx).
  Per frame it emits a payload:
  `{ x, y, detected, isPinching, pinchStrength, pinchDistance, isFist,
     fistStrength, isHandOpen, pinkyThumbDistanceRatio }`.
  - `isPinching` (thumb–index distance) → click / drag-scroll
    ([GestureControl.jsx](../../src/components/GestureControl.jsx)).
  - `isFist` / `isHandOpen` (pinky–thumb distance vs thresholds) are computed but
    only lightly used.
- There are **no named gesture classes** like `swipe / thumbs-up / open-palm` to
  "reuse," and no MLP head to retrain. **See the open decision in §9.**

## 9. Open decisions to confirm before I proceed

These are the places the real backend contradicts the prompt. I need a ruling on
1 and 2 before Phase 1; 3–5 I will proceed on as stated unless you object.

1. **How the mirror widget calls wardrobe routes (auth).** The API contract in
   the prompt specifies JWT-Bearer + `/profiles/:profileId/...` for *both*
   clients, but the mirror display has no JWT — it only knows its `mirrorId`.
   Options:
   - **(A, recommended) Mirror it on the existing Gmail/Spotify dual pattern:**
     implement the contract's JWT routes verbatim under
     `/api/profiles/:profileId/wardrobe/...` (the Flutter app uses these), **and**
     add a thin parallel public set under `/api/mirrors/wardrobe/...?mid=` that
     resolves `mid → active profile` (exactly like `getActiveProfile`) for the
     mirror widget. No new auth system; reuses both existing patterns. The
     `01_api_contract.md` stays the single source of truth for the Flutter side.
   - **(B) Require the mirror to be logged in** and have the widget send the
     stored `mirrorBackendToken`. Simpler surface, but the steady-state mirror is
     not logged in, so this changes the mirror's operating assumptions.
   - I plan to go with **(A)**.

2. **Gestures (Phase 6).** Since no MLP/gesture-class system exists, the prompt's
   "add one class `wardrobe_invoke`, freeze the feature extractor, retrain the MLP
   head, `gesture_recapture.py`" cannot be done as written. Options:
   - **(A, recommended) Geometric gestures from the existing signals:** map
     wardrobe actions onto the data `HandTrackingService` already emits
     (e.g. open-palm dwell = `wardrobe_invoke`, pinch = select/render,
     directional pinch-drag = `next_outfit`, fist = `dismiss`, and on-screen
     thumb-up/down hit-targets for feedback). No new model, nothing to train,
     consistent with how the mirror works today. `tools/gesture_recapture.py`
     becomes a documented *optional* future task rather than a required retrain.
   - **(B) Introduce a brand-new lightweight landmark classifier** (TF.js or a
     Python sidecar) and a real `wardrobe_invoke` class — much larger scope,
     adds an ML training burden the project doesn't currently have.
   - I plan to go with **(A)** and document the mapping in
     `docs/wardrobe/wardrobe_gestures.md`.

3. **`firebase-admin` is a dependency** but used *only* for FCM push
   ([services/pushService.js]) — **not** Auth or Firestore. This is consistent
   with "no Firebase Auth / no Firestore." I will not touch it or introduce
   Firebase for wardrobe data.

4. **`body_photo` storage:** I'll add a `body_photo_filename` column to
   `profiles` via the existing idempotent `ALTER TABLE ... ADD COLUMN ... .catch()`
   pattern (low risk — that's exactly how `face_filename`, `widgets_config`, etc.
   were added). Documented in the Phase 1 schema.

5. **Image URL shape:** stored as filenames; full `imageUrl`/`thumbnailUrl`
   built from the request host at response time (matching the faces approach),
   not stored absolute.

## 10. WebSocket note (for Phase 6 "push" + the no-touch crypto rule)

- `sync/` (TS) is the **encrypted** mirror↔backend channel; `sync/crypto.ts` is
  off-limits. The React UI does not talk to it directly — it polls a local HTTP
  bridge (`useMirrorSync` → `http://localhost:4002/status`).
- The backend's `mirrorSync` service (plain `ws` on port 4000,
  [services/mirrorSync.js]) carries unencrypted JSON control messages. If a push
  message type is needed for the widget, it can be added to the **plain** message
  set ([sync/types.ts] `BackendMessage`/`BridgeMessage`) **without** touching the
  crypto layer. The widget's WebSocket subscription is optional; the core flow is
  request/response over HTTP.
```
