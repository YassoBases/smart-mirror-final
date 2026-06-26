# Phase 2 — Item routes, body photo, upload pipeline

## Routes (dual, per the contract)

Defined once in [backend/src/routes/wardrobe.js](../../backend/src/routes/wardrobe.js)
(single `ENDPOINTS` table → two routers):

- **JWT (Flutter)** mounted at `/api/profiles/:profileId` → `authenticate` +
  `requireProfileJwt` (household guard):
  `POST/GET /wardrobe/items`, `PATCH/DELETE /wardrobe/items/:id`,
  `POST/GET /body-photo`.
- **Mirror widget** mounted at `/api/mirrors/wardrobe` → `requireProfileMid`
  (resolves active profile from `?mid`): same handlers at `/items`,
  `/items/:id`, `/body-photo`.

Both call the shared [wardrobeController.js](../../backend/src/controllers/wardrobeController.js),
which reads `req.wardrobeProfileId` set by the resolution middleware
([wardrobeProfile.js](../../backend/src/middleware/wardrobeProfile.js)).

## Upload pipeline

[wardrobeImageService.js](../../backend/src/services/wardrobeImageService.js),
on `POST .../items` (multipart field `image`, multer **memoryStorage**, 12 MB cap,
image-mimetype filter):

1. Validate it decodes as an image (sharp) → else **400**.
2. Resize the original to ≤ 1024px longest edge (EXIF-rotated) → `original.jpg`.
3. Background removal via the **bg_remover** sidecar (`BG_REMOVER_URL`) → `nobg.png`.
4. Thumbnail from the nobg image (alpha flattened to white) → `thumb.jpg`.
5. Attributes via the **BLIP-2** client (`BLIP2_ENDPOINT_URL`) — aspect-ratio
   category hint passed in.
6. Insert row (id obtained first so files land under `<profileId>/<itemId>/`),
   then `updateItem` with filenames + attributes; return the full item.

### Graceful fallbacks (so the feature works before sidecars deploy / in tests)

- **bg removal unset or failing** → the resized original is used as the nobg
  image (logged; no transparency, but a valid item).
- **BLIP-2 unset or failing** → conservative stub attributes (category from
  aspect ratio or `top`, `formality/warmth = 3`, current season) and the response
  carries **`aiAttributesAvailable: false`** so the client prompts the user to
  fill them in.

## Validation

zod schemas in [validation/wardrobe.js](../../backend/src/validation/wardrobe.js).
PATCH bodies are `.partial().strip()` (unknown keys dropped); invalid enums /
out-of-range numbers → **400**. PATCH/DELETE also verify the item belongs to the
resolved profile → **404** otherwise.

## Tests (Jest + supertest)

`backend/__tests__/`: `wardrobe.items.test.js`, `wardrobe.bodyPhoto.test.js`,
`wardrobe.mirror.test.js`. Cover create/list(+filters)/patch(+invalid 400)/delete
(soft), 401 without auth, the **cross-household 403 guard**, body-photo
post/get/empty, and the mirror `?mid=` path (400 missing / 404 unknown / resolves
active profile). Run: `cd backend && npm test`. Isolated by
[jest.setup.js](../../backend/jest.setup.js) (`:memory:` DB, temp image dir,
sidecars unset). **14 tests, all passing.**
