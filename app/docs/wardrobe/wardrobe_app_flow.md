# Wardrobe app flow

The user journey for the wardrobe / virtual-try-on feature, the exact screens
involved, and the API calls each makes. Routes are documented in the §2 contract
(see the project prompt) and consumed via the single `ApiService`
(`lib/services/api_service.dart`); every URL is `${ApiConfig.baseUrl}/...` and
every call carries the existing JWT Bearer token. Models decode tolerantly per
[00_app_findings.md](00_app_findings.md) §2 and the cross-format §3 rules.

## Entry point

`Closet` is the 5th bottom-nav tab (`lib/screens/main_navigation.dart`):
`IndexedStack` child `WardrobeHomeScreen(isActive: _currentIndex == 4)` +
`BottomNavigationBarItem(Icons.checkroom, 'Closet')`. `WardrobeProvider` is
registered in `lib/main.dart`'s `MultiProvider`.

> Alternative considered: nesting the closet under the Profiles tab. The 5th tab
> was implemented by default (per the prompt); the nesting option is noted only.

## 1. Browse the closet — `WardrobeHomeScreen`

- On open: `ApiService.listProfiles()` (existing) → profile selector (shown only
  when >1 profile; defaults to first). Selecting a profile calls
  `WardrobeProvider.selectProfile(id)` then `load(api)` →
  **`GET /profiles/:id/wardrobe/items`**.
- Also fires `getBodyPhoto(id)` → **`GET /profiles/:id/body-photo`** to drive the
  app-bar body-photo checkmark.
- Renders a responsive thumbnail grid (2 cols phone / 3 cols ≥600px). Each tile:
  `thumbnailUrl` (falls back to `imageUrl`, placeholder on null/error) + category
  + primary-colour swatch.
- States: spinner while loading; `ConnectionErrorView` on connectivity failure;
  inline error + Retry on `ApiException`; empty state with an add button;
  pull-to-refresh re-runs `load`.
- App bar: outfit-preview, body-photo (checkmark badge), and an overflow menu
  (Feedback history / Acceptance rate). FAB → add sheet (camera / gallery).

## 2. Add an item

### Camera — `CaptureItemScreen`
Single tap-to-capture (rear camera, no ML Kit). Tips banner + one-time explainer.
Capture → preview → "Use photo" → shared `uploadAndOpenEditor`:
**`POST /profiles/:id/wardrobe/items`** (multipart, field **`image`**) →
returns the AI-detected item → `ItemEditorScreen` in confirm mode.

### Gallery — `importFromGallery` (`gallery_import.dart`)
`image_picker.pickMultiImage()`:
- 1 pick → same `uploadAndOpenEditor` flow (→ editor).
- many → sequential **`POST .../wardrobe/items`** per file with a running
  "Uploading N of M…" dialog, per-item failure tolerance, summary snackbar; each
  success is added to `WardrobeProvider`. Batch skips the editor (refine later by
  tapping items).

## 3. Confirm / edit attributes — `ItemEditorScreen`

Used for confirm-after-capture (`isNew: true`) and edit-existing (`isNew:false`).
Edits category / subcategory / pattern / primary+secondary colours / fabric /
formality / warmth / seasons / tags.
- Save → **`PATCH /profiles/:id/wardrobe/items/:itemId`** with `toPatchJson()`
  (editable attrs only) → `WardrobeProvider.addItem` (new) or `replaceItem`
  (edit) → pop. The grid updates with no reload.
- Delete (edit mode) → confirm → **`DELETE .../wardrobe/items/:itemId`** →
  `WardrobeProvider.removeItem` → pop.

## 4. Base body photo — `BodyPhotoScreen`

Opened from the closet app bar. One photo per profile, reused by the mirror for
every render.
- On open: **`GET /profiles/:id/body-photo`**. Existing photo → review mode
  (with "Replace photo"); none → capture mode.
- Tips banner + one-time explainer (states the mirror uses it and it is stored on
  the household's own backend).
- Capture → preview → "Use photo" → **`POST /profiles/:id/body-photo`**
  (multipart, field **`photo`**) → review mode. Pops `true` so the closet sets
  its checkmark.

## 5. Outfit preview + feedback — `OutfitPreviewScreen`

Secondary phone-side surface (the mirror is primary).
- "Suggest an outfit" → **`POST /profiles/:id/outfit/suggest`** → candidates +
  context. Board = item thumbnails (resolved from `WardrobeProvider`) + reasoning
  + context chips (temp/weather/time/season). Multiple candidates → pager.
- Like / Dislike → **`POST /profiles/:id/outfit/feedback`** with `itemIds`,
  `rating`, `reasoningShown: true`, echoed `context`.
- "Render on me" → **`POST /profiles/:id/outfit/render`** → shows `renderUrl`
  with an overlay spinner (board/render stays visible); failures inline.

## 6. Feedback history — `FeedbackHistoryScreen`

Overflow menu → paginated **`GET /profiles/:id/outfit/feedback?limit&offset`**
(rating, item count, local date), "Load more" + pull-to-refresh.

## 7. Acceptance metrics (optional) — `AcceptanceScreen`

Overflow menu → **`GET /profiles/:id/metrics/acceptance`** → weekly
acceptance-rate bars + `modelTrainedAt`. Degrades to an empty state if the
backend does not implement it.

## Cross-cutting

- Auth/HTTP: all calls go through `context.read<AuthProvider>().api`
  (`ApiService`); no new client or auth.
- Image URLs: `resolveServerUrl` (`lib/models/server_url.dart`) — absolute pass
  through; relative/bare-filename joined onto the server root (trailing `/api`
  stripped from `ApiConfig.baseUrl`), so re-provisioning fixes them.
- Failure UX: `ApiException` → inline error; other exceptions → `ConnectionErrorView`.

## Follow-ups / caveats

- Backend authority: if the running backend's wardrobe responses differ from the
  §2 contract, the backend wins (models already decode both camelCase and
  snake_case). Flag material differences rather than adapting silently.
- iOS only: `image_picker` photo-library access needs
  `NSPhotoLibraryUsageDescription` (and camera already needs
  `NSCameraUsageDescription`) in `ios/Runner/Info.plist`. Not required for the
  Android debug build, which is the verified target.
- `sendOutfitFeedback`'s `reasoningShown` is a `bool` (contract shape), not the
  `String` the prompt's §4 signature listed — see [00_app_findings.md](00_app_findings.md).
