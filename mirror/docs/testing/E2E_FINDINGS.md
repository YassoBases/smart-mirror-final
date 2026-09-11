# End-to-End Testing Findings

Defects found while building out E2E coverage for the Smart Mirror project
(feature inventory in [FEATURE_MATRIX.md](./FEATURE_MATRIX.md)). Each entry
records reproduction steps, severity, and fix status as of this session.

---

## 1. Profile-switch race: stale wardrobe response repopulates state after switch

**Severity:** Medium — data leaks visually across profiles for a moment, not persisted.

**Status:** Fixed, regression test in place.

**Repro (pre-fix):** Profile A opens the wardrobe widget and requests
suggestions (`wardrobeApi.suggest`). Before that request resolves, the active
profile switches to B (e.g. a different person steps in front of the mirror).
The in-flight response for A then resolves and calls `setCandidates`,
`setItemsById`, etc., repopulating the widget with A's outfit data while B is
now the active profile.

**Fix:** [src/widgets/Wardrobe/useWardrobeSession.js](../../src/widgets/Wardrobe/useWardrobeSession.js)
adds a session-generation counter (`epoch`, introduced in commit `3fac822`).
Every async action (`invoke`, `generate`, `renderVton`, `sendFeedback`)
captures `epoch.current` before its `await` and checks it hasn't changed
before applying the result; `reset()` (called on every profile change, see
[index.jsx:32-40](../../src/widgets/Wardrobe/index.jsx#L32-L40)) bumps the
epoch, invalidating any request that was already in flight.

**Regression test:** `flows.test.jsx` — *"profile switch invalidates an
outstanding wardrobe result"* (holds the `suggest()` promise open, switches
`mockProfileId`, then resolves it and asserts the stale `'OLD PROFILE'` text
never renders). Confirmed passing in this session's frontend run
(5 suites / 30 tests, all green).

---

## 2. Wardrobe render storage-path mismatch (files written but served from the wrong directory)

**Severity:** High — broke rendered try-on images (404) in any environment where
`WARDROBE_DATA_DIR` differs from the hard-coded default.

**Status:** Fixed and re-confirmed in this session.

**Repro (pre-fix):** Wardrobe item/render files are written under
`WARDROBE_DATA_DIR` (see `backend/db/wardrobe.js`), but
[backend/src/app.js](../../backend/src/app.js) served static wardrobe assets
from a hard-coded `../data/wardrobe` path regardless of that env var. In any
deployment where `WARDROBE_DATA_DIR` was set to a different location, every
`/wardrobe/<profileId>/<itemId>/...` URL 404'd even though the file existed on
disk.

**Fix:** commit `3fac822` changed the static mount to
`express.static(require("../db/wardrobe").WARDROBE_DATA_DIR)` so the served
directory always matches where files are actually written.

**Confirmation (this session, task 3.1):** Re-ran the full backend journeys
suite (`npm test -- journeys`) — all 6 journeys (household setup, wardrobe
lifecycle, outfit journey, try-on, alerts, profile switching) pass, including
image round-trips through the render path. The suite had failed on first run
this session, but for an unrelated reason: this machine's default Python
environment was missing `transformers`, `joblib`, `lightgbm`, and
`scikit-learn` (all already pinned in the respective services'
`requirements.txt`), which prevented `wardrobe_attr` and `pref_ranker` from
starting at all. Installing those packages resolved it; no code was at
fault. Full run: 7 suites / 41 tests passing (see commit `bf3147f`).

---

## 3. WebSocket resync returns an empty module snapshot (state actually flows over HTTP polling)

**Severity:** Medium — the WebSocket resync path is effectively dead code for
state delivery; not a functional regression today because polling covers it,
but a defense/reviewer question waiting to be asked.

**Status:** Found, **not fixed** — recorded as a finding per instructions.

**Detail:** [backend/src/services/mirrorSync.js:79-81](../../backend/src/services/mirrorSync.js#L79-L81):

```js
case 'resync':
  send(ws, { type: 'snapshot', version: 1, state: { modules: {} } });
  break;
```

Any client that asks the mirror-sync WebSocket to resync gets back a snapshot
with an always-empty `modules` object — never the household's actual profile,
wardrobe, or widget-settings state. In practice this doesn't break the
product because [src/hooks/useMirrorSync.js](../../src/hooks/useMirrorSync.js)
never relies on it: the mirror app polls the local sync bridge's `GET
/status` endpoint every second (`POLL_INTERVAL_MS = 1_000`) and gets full
state that way. So state does reach the mirror — just not through the code
path that looks, from the WebSocket protocol, like it's supposed to carry it.

**Why this is left alone:** per session instructions, this may be an
intentional stub (WebSocket kept for phase/QR signaling, HTTP polling doing
the actual state sync) rather than an oversight, and fixing it wasn't in
scope this round. Flagging plainly so it's an explicit, known finding rather
than something discovered live under questioning.

---

## 4. Live try-on: warp reference pose can mismatch the live pose at keyframe arrival

**Severity:** Low/architectural — not a bug, a real limitation of the current
design that should be stated up front.

**Status:** Known limitation, documented, not something to silently "fix."

**Detail:** The hosted renderer produces the still keyframe from a *saved body
photo*, not the live camera frame. The shoulder-similarity warp
(translation/rotation/scale, tested to ±25°) reprojects that keyframe onto the
live pose between refreshes, but the reference pose baked into the keyframe
image was whatever pose the saved photo captured — not necessarily the pose
the user is standing in the moment the new keyframe actually arrives. Between
a keyframe request and its response, the live warp is doing its best with a
reference that may already be stale in both time and pose. This is inherent
to using a still-image renderer as the source of the live layer, not a
transform-math bug; the transform itself is correctly tested for what it
does (see `warpGarment.test.js`).

**Why this belongs here:** it's exactly the kind of architectural constraint
a defense/review would ask about directly, so it should be documented as a
known-and-understood limitation rather than left implicit.

---

## 5. `bg_remover` degrades to the original (non-background-removed) image when the u2net model isn't cached

**Severity:** Low — this is the designed fallback behavior working as intended, recorded here because it was observed during this session's journeys run and is worth knowing about for the manual test plan.

**Status:** Not a defect — confirming existing designed behavior.

**Detail:** [services/bg_remover/app.py](../../services/bg_remover/app.py) lazily
loads the `rembg`/`u2net` session on first `/remove` call. If model weights
aren't already cached locally (first run, or no cached `~/.u2net` directory)
the load can fail or the fetch can be slow enough that the caller times out,
and the endpoint returns `503`. `backend/src/services/wardrobeImageService.js`
already catches this (`[wardrobeImage] bg removal failed, using original`) and
falls back to the plain uploaded image rather than failing the upload. Seen
live during this session's `journeys.test.js` run and during
`services/smoke_http.py` before the `rembg`/`onnxruntime` packages were
installed into this machine's Python environment. Once installed and the
model is fetched/cached, `smoke_http.py` passes cleanly for `bg_remover` too.
No code change needed — flagging only so a cold-start 503 on a fresh
environment isn't mistaken for a new regression.

---

## 6. app↔backend: dead-code drift in two client-side field-name fallbacks

**Severity:** Low — no functional bug (the code paths that would need the dead
convention are never hit), but confirmed genuine drift between the two sides.

**Status:** Found via a new contract test (`backend/__tests__/app_contract.test.js`),
task 3.4. Not fixed — `app/` is read-only for this work, and per instructions
this is a finding to record, not something to silently clean up.

**Detail 1 — `renderGeneratedOutfit`'s snake_case fallback is dead:**
[app/lib/services/api_service.dart:636-637](../../../app/lib/services/api_service.dart#L636-L637)
reads `body['tryOnUrl'] ?? body['try_on_url']` and `body['generationId'] ??
body['generation_id']`. The backend
([backend/src/controllers/wardrobeController.js:683-686](../../backend/src/controllers/wardrobeController.js#L683-L686))
only ever returns `{ generationId, tryOnUrl }` — camelCase, never
snake_case. The snake_case branch is leftover defensiveness from an earlier
naming convention that no longer exists server-side.

**Detail 2 — `spotify_connected`/`spotify_display_name` only exist on the
single-profile response, not the list:**
[app/lib/models/profile.dart](../../../app/lib/models/profile.dart) reads
`spotify_connected` and `spotify_display_name` off any `Profile.fromJson`
call. `GET /api/profiles` (list) is backed by
`profileService.listProfiles()`, whose query never joins
`spotify_connections` and so never emits those two fields; `GET
/api/profiles/:id` (single) does, via a join in `profileService.getProfile()`.
In practice this isn't a live bug: the only place `Profile.hasSpotify` is
read (`app/lib/screens/profile_screen.dart`) always calls `getProfile(id)`
in `initState` before rendering, which masks the gap. But it means a
`Profile` sourced purely from the list endpoint can never answer
`hasSpotify` correctly, and nothing currently stops a future screen from
reading it off a list-sourced profile and silently showing "not connected"
for a connected account.

**Why left alone:** both are exactly the "client accepts a convention the
backend no longer emits" case called out in this session's instructions —
recorded as findings rather than quietly deleted or fixed, since `app/` is
out of scope to modify and the backend side is working as intended.

**Cross-check requested for task 3.2:** whether any front-end widget test
assumes the app's `Profile.fromJson` list-endpoint gap (Detail 2 above). The
React mirror front-end has no equivalent "list of profiles" widget — it only
ever renders one active profile per mirror — so that specific gap has no
front-end analogue and no test assumes it. While checking this, found a
third, separate instance of the same dead-code pattern on the mirror
front-end itself (recorded below as its own item, #7), added while doing
task 3.2.

---

## 7. Mirror front-end: `backendApi._normalizeProfile`'s nested `integrations.*` shape is dead code

**Severity:** Low — same category as #6, no live bug, confirmed via a new test.

**Status:** Found in task 3.2 while cross-checking for #6-style drift on the
mirror front-end. Not fixed — flagged per the same "document, don't silently
remove" instruction, and removing it would be an unrequested refactor of a
shared normalizer.

**Detail:** [src/services/backendApi.js:279-283](../../src/services/backendApi.js#L279-L283)
(`_normalizeProfile`) reads connection status as
`raw.integrations?.gmail?.connected ?? raw.gmailConnected` and
`raw.integrations?.spotify?.connected ?? raw.spotifyConnected` — preferring a
nested `integrations: { gmail: {...}, spotify: {...} }` shape over the flat
legacy fields. `_normalizeProfile` has exactly one caller,
`backendApi.getActiveProfile()`, which fetches
`GET /api/mirrors/active-user`; that route
([backend/src/routes/mirrors.js:254-265](../../backend/src/routes/mirrors.js#L254-L265))
always returns the flat shape (`gmailConnected`, `spotifyConnected`, etc.)
and never a nested `integrations` object. A repo-wide search turns up no
producer of that nested shape anywhere — the only other place the word
`integrations` appears is the unrelated `/api/mirrors/integrations` endpoint
(household-level shared credentials, a completely different concept). So the
nested branch is dead: it would only ever activate in a test that constructs
it by hand, never against a real response.

**Regression/contract test:** `src/services/backendApi.test.js` — asserts
the real flat shape normalizes correctly, and separately documents (with a
passing test) that the nested shape *would* take priority if it existed, to
make the branch's continued existence and current inertness both explicit
and test-visible rather than silently assumed.

---

## Session environment note (not a product defect)

This machine's default `python` on `PATH` resolves to a virtualenv
(`hermes-agent\venv`) that did not have `transformers`, `joblib`, `lightgbm`,
`scikit-learn`, `rembg`, or `onnxruntime` installed, even though all of them
are already pinned in `services/wardrobe_attr/requirements.txt`,
`services/pref_ranker/requirements.txt`, and
`services/bg_remover/requirements.txt`. This blocked `journeys.test.js` and
`services/smoke_http.py` from starting the Python services at all (not from
running them incorrectly). Installed the missing packages into that same
venv for this session; no repository changes were needed since the
requirements files were already correct. Noting this so a future run on a
differently-provisioned machine isn't surprised by the same symptom, and
so a real service-side regression isn't confused with a missing-dependency
environment gap.
