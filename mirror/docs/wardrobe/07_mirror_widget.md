# Phase 6 — Mirror widget + gesture trigger

[src/widgets/Wardrobe/](../../src/widgets/Wardrobe/), registered the existing way
(an entry in [src/data/apps.js](../../src/data/apps.js) + a `componentMap` entry in
[SmartMirror.jsx](../../src/pages/SmartMirror.jsx)). Shipped **disabled by
default** so it never changes existing layouts; enable it from settings like any
other widget.

## Components

- [index.jsx](../../src/widgets/Wardrobe/index.jsx) — shell + session state machine
  view: `idle → loading_suggestion → showing_board → rendering_vton →
  showing_vton → awaiting_feedback → idle`. Subscribes to the existing sync layer
  via a `smartMirror:wardrobe` window event for push triggering.
- [OutfitBoard.jsx](../../src/widgets/Wardrobe/OutfitBoard.jsx) — 2D flat-lay (top
  centered, bottom below; outerwear/footwear/accessories in a sidebar — they are
  not composited into the render). Framer Motion transitions on candidate change.
- [VtonView.jsx](../../src/widgets/Wardrobe/VtonView.jsx) — full render as an
  overlay; while rendering, the OutfitBoard stays visible underneath (never an
  empty screen). Flips to `awaiting_feedback` once the image loads.
- [ReasoningCard.jsx](../../src/widgets/Wardrobe/ReasoningCard.jsx) — XAI panel
  (reasoning, confidence, context summary).
- [FeedbackHint.jsx](../../src/widgets/Wardrobe/FeedbackHint.jsx) — thumbs up/down
  targets (inline SVG, **no emoji**).
- [useWardrobeSession.js](../../src/widgets/Wardrobe/useWardrobeSession.js) — the
  hook driving the machine + backend calls.
- [gestureMap.js](../../src/widgets/Wardrobe/gestureMap.js) — gesture→action map +
  the geometric recognizer.
- [wardrobeApi.js](../../src/widgets/Wardrobe/wardrobeApi.js) — calls the public
  mirror routes `/api/mirrors/wardrobe/*?mid=<mirrorId>` (the mirror holds no JWT;
  the routes resolve the active profile from `mid`).

## Data flow

`wardrobe_invoke` → `listItems` + `outfit/suggest` (parallel) → OutfitBoard +
ReasoningCard. `next_outfit` cycles candidates locally. `render_vton` →
`outfit/render` → VtonView (loading over the board, then result). `feedback_up`/
`feedback_down` → `outfit/feedback` → back to idle. The active profile comes from
the mirror id (`backendApi.getMirrorId()`), resolved server-side — the same
active-user mechanism the rest of the mirror uses.

## Gestures

Geometric (no MLP — see [wardrobe_gestures.md](wardrobe_gestures.md) for the full
table). The one new class `wardrobe_invoke` = open-palm dwell. `next_outfit` =
swipe, `dismiss` = fist dwell; `render_vton`/`feedback_*` are on-screen targets
driven by the mirror's existing pinch-to-click. The recognizer listens to a
`smartMirror:hand` `CustomEvent` that SmartMirror now re-broadcasts (one additive
line in `handleHandPosition`) — no second camera. `tools/gesture_recapture.py` is
the optional learned-classifier scaffold.

## Non-breaking changes to existing files

1. `src/data/apps.js` — one new `wardrobe` entry (`enabled: false`).
2. `src/pages/SmartMirror.jsx` — import `WardrobeWidget`, add it to
   `componentMap`, and one `window.dispatchEvent('smartMirror:hand', …)` line.

Nothing else in the existing UI changed.

## Verification

`npm run build` (CRA production build) **succeeds** — "build folder is ready to
be deployed". The only lint warnings are pre-existing files
(HandTrackingService, useAIAssistant, Model, Settings); **zero** warnings or
errors from any wardrobe file. (Root install uses `npm install
--legacy-peer-deps`, the repo's existing requirement — TypeScript 5.9 for the
`sync/` code vs react-scripts' older peer range; unrelated to this feature.)
