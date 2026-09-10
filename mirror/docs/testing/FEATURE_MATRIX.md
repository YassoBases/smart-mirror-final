# Feature matrix

Inventory recorded before Part B tests, at A6 commit 880553f. Existing tests means coverage at this point, not a claim of full feature validation. Paths below are repository-relative; app/ is read-only.

| Feature | Components and boundaries | Existing coverage | Verification |
|---|---|---|---|
| Account and household setup | auth, households; welcome/login/register/create_household screens | No existing journey tests | HTTP automatic; phone navigation manual |
| Profile CRUD and selection | profiles, mirrors/active-user; ProfileContext; profile/add_profile/dashboard/home | wardrobe.mirror scope only | HTTP/RTL automatic; recognition hardware |
| Face enrollment, recognition, guest/idle transitions | profiles face/faces; faceRecognition service; SmartMirror; face_setup | None | State transitions automatic; camera accuracy/manual |
| BLE Wi-Fi provisioning and change network | provisioning routes; provisioning Linux units; BLE/connectivity screens | None | Pi + factory-state phone required |
| QR and short-code pairing, reconnection and resync | mirrorSync WebSocket; mirrors/pair; PairingScreen; pair_mirror | None | WebSocket + HTTP automatic; scan/BLE hardware |
| Widget settings and draggable layout | profiles widgets; Settings, ModelSettings, DraggableApp; app_settings | None | HTTP/RTL automatic; pinch hardware |
| Shared integration credentials and per-profile AI settings | settings, mirrors/integrations, profiles/ai-settings; Settings; ai_settings | None | Contract automatic; real cloud credentials manual |
| Voice assistant, context, realtime audio and commands | AIAssistantOverlay; assistant services; SmartMirror | None | Protocol/UI automatic; microphone/network manual |
| Hands-free next/dismiss and pinch cursor | HandTrackingService, CursorOverlay, GestureControl, gestureMap | None before A1 | Dispatch automatic; three physical gestures/manual |
| Clock, date, calendar display | apps/ClockApp, DateApp, DateTimeApp | None; calendar is date display, no event calendar integration found | RTL automatic |
| Weather/location/forecast | apps/WeatherApp; context service | None | RTL automatic; external weather/network manual |
| News feeds and source selection | apps/NewsApp; news/rss allowlisted proxy | None | RTL/HTTP automatic; remote feed availability manual |
| Gmail connect, disconnect, messages | gmail callback; profiles Gmail; mirrors Gmail; apps/gmail | None | Boundary automatic; OAuth consent/real mailbox manual |
| Spotify OAuth, status, search/play, transfer, web playback | spotify callback; profiles Spotify; mirrors Spotify; apps/spotify | None | Boundary automatic; paid account/audio device manual |
| Unknown face alerts, snapshot, history, push token registration | mirrors unknown-face, alerts, devices; Alerts; alert_screen | None | HTTP + SDK boundary automatic; phone delivery hardware |
| Garment capture/import, classification, removal, browse/edit/delete | wardrobe/items; wardrobe_attr; bg_remover; wardrobe mobile screens | wardrobe.items fallback-only | Real Python + HTTP automatic; real garment manual |
| Saved body photo upload/retrieval | body-photo; body_photo_screen | wardrobe.bodyPhoto | HTTP automatic; photo framing manual |
| Closet suggestion, reasoning, preference ranking, feedback/history/acceptance | outfit/suggest,feedback,metrics; pref_ranker; OutfitBoard/ReasoningCard/FeedbackHint | wardrobe.outfit offline fallback | Real ranker + HTTP automatic; quality manual |
| Generate new ideas, product images, still render and gallery | outfit/generate,generate/render,generations; GeneratedBoard; discover/gallery/outfit_preview | No hosted boundary journey | HTTP/RTL automatic; cloud quality manual |
| Closet still try-on and cache | outfit/render; VtonView; outfit_preview | wardrobe.outfit unconfigured fallback | Hosted boundary automatic; appearance manual |
| Live torso warp, refresh, stats, still fallback | poseTracking, garmentLayer, warpGarment,useLiveTryOn,VtonView | A1 3 tests; A3 4 geometry tests | RTL/math automatic; Pi FPS/motion/segmentation hardware |
| Connection gate, server address, offline recovery | connection_settings,connectivity_gate; backendApi; sync client | None | HTTP/RTL automatic; network recovery hardware |
| Unattended startup, long-running stability | deployment units, kiosk, setup/welcome; splash/main_navigation | None | Pi cold boot and six-hour soak required |

## Source manifest

Every discovered screen, page, widget and route is listed to make omissions reviewable. Shared implementations are grouped in the feature table above.

### Backend routes

- `mirror/backend/src/routes/alerts.js`
- `mirror/backend/src/routes/auth.js`
- `mirror/backend/src/routes/devices.js`
- `mirror/backend/src/routes/gmail.js`
- `mirror/backend/src/routes/households.js`
- `mirror/backend/src/routes/mirrors.js`
- `mirror/backend/src/routes/news.js`
- `mirror/backend/src/routes/profiles.js`
- `mirror/backend/src/routes/provisioning.js`
- `mirror/backend/src/routes/settings.js`
- `mirror/backend/src/routes/spotify.js`
- `mirror/backend/src/routes/wardrobe.js`

### Mirror pages

- `mirror/src/pages/Alerts.jsx`
- `mirror/src/pages/Model.jsx`
- `mirror/src/pages/ModelSettings.jsx`
- `mirror/src/pages/PhonePair.jsx`
- `mirror/src/pages/Settings.jsx`
- `mirror/src/pages/SmartMirror.jsx`

### Mirror apps

- `mirror/src/apps/ClockApp.jsx`
- `mirror/src/apps/DateApp.jsx`
- `mirror/src/apps/DateTimeApp.jsx`
- `mirror/src/apps/gmail/GmailApp.jsx`
- `mirror/src/apps/HandTrackingApp.jsx`
- `mirror/src/apps/NewsApp.jsx`
- `mirror/src/apps/spotify/App.jsx`
- `mirror/src/apps/WeatherApp.jsx`

### Wardrobe views

- `mirror/src/widgets/Wardrobe/FeedbackHint.jsx`
- `mirror/src/widgets/Wardrobe/GeneratedBoard.jsx`
- `mirror/src/widgets/Wardrobe/index.jsx`
- `mirror/src/widgets/Wardrobe/OutfitBoard.jsx`
- `mirror/src/widgets/Wardrobe/ReasoningCard.jsx`
- `mirror/src/widgets/Wardrobe/VtonView.jsx`

### Flutter screens

- `app/lib/screens/add_profile_screen.dart`
- `app/lib/screens/ai_settings_screen.dart`
- `app/lib/screens/alert_screen.dart`
- `app/lib/screens/app_settings_screen.dart`
- `app/lib/screens/connect_mirror_screen.dart`
- `app/lib/screens/connection_settings_screen.dart`
- `app/lib/screens/connectivity_gate.dart`
- `app/lib/screens/dashboard_screen.dart`
- `app/lib/screens/face_setup_screen.dart`
- `app/lib/screens/home_screen.dart`
- `app/lib/screens/login_screen.dart`
- `app/lib/screens/main_navigation.dart`
- `app/lib/screens/onboarding/ble_setup_screen.dart`
- `app/lib/screens/onboarding/create_household_screen.dart`
- `app/lib/screens/onboarding/register_screen.dart`
- `app/lib/screens/pair_mirror_screen.dart`
- `app/lib/screens/profile_screen.dart`
- `app/lib/screens/splash_screen.dart`
- `app/lib/screens/wardrobe/acceptance_screen.dart`
- `app/lib/screens/wardrobe/body_photo_screen.dart`
- `app/lib/screens/wardrobe/capture_item_screen.dart`
- `app/lib/screens/wardrobe/discover_screen.dart`
- `app/lib/screens/wardrobe/feedback_history_screen.dart`
- `app/lib/screens/wardrobe/gallery_import.dart`
- `app/lib/screens/wardrobe/generations_gallery_screen.dart`
- `app/lib/screens/wardrobe/item_editor_screen.dart`
- `app/lib/screens/wardrobe/outfit_preview_screen.dart`
- `app/lib/screens/wardrobe/wardrobe_home_screen.dart`
- `app/lib/screens/welcome_screen.dart`

## Existing test inventory

- `mirror/backend/__tests__/classifier.config.test.js`
- `mirror/backend/__tests__/wardrobe.bodyPhoto.test.js`
- `mirror/backend/__tests__/wardrobe.items.test.js`
- `mirror/backend/__tests__/wardrobe.mirror.test.js`
- `mirror/backend/__tests__/wardrobe.outfit.test.js`

No existing frontend widget suite was found before Part A. BLE, OAuth consent, recognition accuracy, video FPS and physical display quality cannot be established by HTTP or jsdom tests.
