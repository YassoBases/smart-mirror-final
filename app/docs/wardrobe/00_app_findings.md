# Phase 0 — App findings

Read of the real app before writing any wardrobe code. The code is truth; this
records what I found and the exact patterns the wardrobe feature will reuse.

## 1. Authenticated `ApiService` + multipart-upload recipe

### Getting an authenticated client

There is exactly one HTTP client: `lib/services/api_service.dart` (`ApiService`).
It is constructed with an optional `token` and exposes everything as instance
methods. You never construct it yourself in a screen — you read it from the
auth provider:

```dart
final api = context.read<AuthProvider>().api;
```

`AuthProvider.api` (`lib/providers/auth_provider.dart:16`) returns
`ApiService(token: _token)`, where `_token` is the JWT restored from
SharedPreferences key `jwt_token`. `_headers` adds `Authorization: Bearer
$token` and `Content-Type: application/json`.

`_parse(res)` (`api_service.dart:32`) is the shared response handler:
- 2xx → returns decoded JSON (or `null` for empty/204/non-JSON 2xx bodies).
- non-2xx → throws `ApiException(message, statusCode)`, pulling `body['error']`
  when present.

List/detail endpoints decode a named key off the parsed body, e.g.
`_parse(res)['profiles']`, `Profile.fromJson(_parse(res)['profile'])`. Wardrobe
methods will follow this: `_parse(res)['item']`, `_parse(res)['items']`, etc.

### Multipart-upload recipe (copied from `uploadFace`, `api_service.dart:145`)

```dart
final url = '${ApiConfig.baseUrl}/profiles/$profileId/face';
var request = http.MultipartRequest('POST', Uri.parse(url));
if (token != null) {
  request.headers['Authorization'] = 'Bearer $token';   // NOT _headers (no Content-Type)
}
request.files.add(await http.MultipartFile.fromPath('face', imagePath));
var streamedResponse = await request.send();
var response = await http.Response.fromStream(streamedResponse);
// then check status / throw ApiException
```

Key detail: multipart uploads set only the `Authorization` header manually (not
the JSON `_headers`), and the existing code hand-rolls the status check rather
than calling `_parse`. The wardrobe item upload uses field name **`image`** and
the body photo uses field name **`photo`** — both differ from the face upload's
`face`/`faces`. To still get a `WardrobeItem`/url back I will run the streamed
response through `_parse` after converting it to an `http.Response`, so the
multipart methods can both throw clean `ApiException`s and decode a JSON body.

## 2. Model decode conventions

From `lib/models/profile.dart`:

- **snake_case keys.** Backend returns raw SQLite rows: `household_id`,
  `face_filename`, `mirror_id`, `spotify_connected`, etc. `fromJson` reads those
  keys directly.
- **JSON-as-TEXT arrays.** `face_filenames` arrives as a JSON *string* like
  `'["a.jpg","b.jpg"]'`. `_parseFaceFilenames` (`profile.dart:67`) tolerates
  either a real `List` or a JSON-encoded `String`, and never throws on bad data.
  `_parseWidgetsConfig` does the same for an object.
- **Integer booleans.** `spotify_connected` is decoded as
  `json['spotify_connected'] == true || json['spotify_connected'] == 1`.
- **`faceUrl` server-root derivation** (`profile.dart:41`): takes
  `ApiConfig.baseUrl`, strips the trailing `/api` to get the server root, then
  appends `/faces/<filename>`. Returns null when no filename.

The wardrobe models will mirror all of this, plus the **cross-format
tolerance** required by §3 of the prompt (accept both camelCase and snake_case
keys, since the wardrobe backend may serialize either way). The server-root
derivation becomes a shared helper `resolveServerUrl(String?)` in
`lib/models/server_url.dart` that additionally tolerates absolute / root-relative
/ bare-filename inputs.

## 3. Camera lifecycle to reuse (and what to strip)

From `lib/screens/face_setup_screen.dart`:

**Keep (the lifecycle template):**
- The widget takes `final bool isActive;` (driven by the IndexedStack tab index).
- `didUpdateWidget` (`face_setup_screen.dart:94`): when `isActive` flips true →
  `_initializeCamera()`; when it flips false → stop image stream, dispose
  controller, `_cameraReady = false`. This is what stops the camera when the
  user leaves the tab.
- `dispose()` closes the controller (and detector).
- `_initializeCamera()` (`:157`): `availableCameras()`, pick a camera,
  `CameraController(... ResolutionPreset.high, enableAudio: false)`, `initialize()`,
  set `_cameraReady`. For item/body capture I'll prefer the **rear** camera
  (`CameraLensDirection.back`) instead of front.
- `takePicture()` to capture a still → an `XFile` with `.path`.
- The profile-selection UI (`_buildProfileSelector`, `:556`): a dark
  `DropdownButton<Profile>` populated from `api.listProfiles()`, defaulting to
  the first profile. This is the profile-picker template for the closet.
- Loading / `ConnectionErrorView` / api-error states around profile loading
  (`_loadProfiles`, `:117`).
- The "upload then route" flow: capture → upload via `ApiService` → advance UI.

**Strip for clothing capture (not needed):**
- `google_mlkit_face_detection` and the whole `FaceDetector` / `_runDetection` /
  `_buildInputImage` / NV21 image-stream pipeline. Item/body capture does **not**
  process frames with ML Kit, so no `startImageStream`, no `imageFormatGroup:
  nv21`.
- Blink liveness (`_updateBlink`, `_BlinkPhase`).
- Multi-pose state machine (`_Pose` front/left/right, `_advance`, burst capture,
  steadiness `trackingId` gating). Item capture is a single tap-to-capture →
  preview → "Retake"/"Use photo". An optional loose steadiness gate is allowed
  but not required and won't use ML Kit.
- The oval face overlay (`_OvalOverlayPainter`) → replaced by a rectangle
  framing overlay (item) / full-body silhouette (body photo).

## 4. Navigation insertion point

File: `lib/screens/main_navigation.dart`.

- `IndexedStack` children list (`main_navigation.dart:89-94`), currently 4:
  `DashboardScreen(isActive: _currentIndex == 0)`, `const AlertScreen()`,
  `FaceSetupScreen(isActive: _currentIndex == 2)`, `const HomeScreen()`.
  → Add a 5th: `WardrobeHomeScreen(isActive: _currentIndex == 4)`.
- `BottomNavigationBar.items` list (`:115-132`), currently 4 items
  (Dashboard / Alerts / Face Setup / Profiles).
  → Add a 5th `BottomNavigationBarItem(icon: Icon(Icons.checkroom), label: 'Closet')`.
- `type: BottomNavigationBarType.fixed` is already set (`:103`) — keep it; five
  fixed items fit.
- Note the `onTap` handler clears the Alerts badge when `index == 1`; the new
  tab needs no special handling.

**Alternative (noted, not chosen):** nest the closet under the Profiles tab
instead of adding a 5th tab. Per the prompt I implement the 5th tab by default.
Body-photo, outfit-preview and feedback-history screens are reachable from the
closet's app bar / actions rather than as their own tabs.

## 5. Provider registration point

File: `lib/main.dart`, the `MultiProvider.providers` list (`main.dart:28-32`):

```dart
providers: [
  ChangeNotifierProvider(create: (_) => AuthProvider()),
  ChangeNotifierProvider(create: (_) => AlertProvider()),
  // → add: ChangeNotifierProvider(create: (_) => WardrobeProvider()),
],
```

`WardrobeProvider` will hold no token; each method receives the `ApiService`
from `context.read<AuthProvider>().api` at the call site (the wardrobe provider
does not depend on AuthProvider, matching how AlertProvider stays independent).

## 6. Where my prompt "Context" section was right vs. needs nuance

Mostly accurate. Corrections / clarifications:

- **`AlertProvider` is not API-backed.** The prompt says model the wardrobe
  provider on `AlertProvider`. In reality `AlertProvider`
  (`lib/providers/alert_provider.dart`) is **SharedPreferences-backed** (local
  push-notification history), *not* the `/alerts` API. The API-backed alert
  fetch lives in `ApiService.getAlerts` → `SecurityAlert`. So for a *structural*
  ChangeNotifier template I'll follow `AlertProvider`'s shape (private list +
  getters + `notifyListeners`), but the actual load/refresh pattern (call
  `api.xxx`, set `loading`/`error`, `ConnectionErrorView` on connectivity
  failure) is better modeled on `HomeScreen._load` / `face_setup`'s
  `_loadProfiles`.
- **Profiles tab is `HomeScreen`**, not a "ProfileScreen" tab. `ProfileScreen`
  is the per-profile detail page pushed from `HomeScreen`. The 4 tabs are
  Dashboard / Alerts / Face Setup(`FaceSetupScreen`) / Profiles(`HomeScreen`).
- **Connectivity vs. API error are handled separately** throughout: a thrown
  `ApiException` → inline red text + Retry; any *other* exception (no
  connection) → `ConnectionErrorView`. The wardrobe screens will follow this
  same split (see `HomeScreen._load`, `:32`).
- **`_headers` includes `Content-Type: application/json`**, so it must *not* be
  used as-is for multipart requests — multipart sets its own content type. The
  existing `uploadFace` correctly sets only `Authorization` manually. Confirmed,
  will follow.
- **Default camera in face setup is front-facing**; item/body capture should use
  the rear camera. Not a contradiction, just a deliberate change.
- **Dependencies:** `camera`, `path_provider`, `provider`, `http`,
  `shared_preferences` already present (`pubspec.yaml`). Only `image_picker` is
  missing and will be added. Dart SDK `^3.5.2` (supports switch-expressions /
  records, which the prompt's return types like `({String renderUrl, bool
  fromCache})` rely on — good).

## 7. Backend contract reconciliation note

The §2 contract documents camelCase JSON with absolute URLs, but this app's
existing backend returns snake_case SQLite rows with JSON-TEXT arrays and
integer booleans. The wardrobe models will decode **both** shapes (§3
tolerance) so they work regardless of which the running backend emits. If the
running backend's responses materially differ from the §2 contract (missing
fields, different route shapes), I will flag it rather than silently adapt.
