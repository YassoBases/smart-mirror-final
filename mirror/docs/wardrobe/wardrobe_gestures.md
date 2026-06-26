# Wardrobe gestures

This project has **no gesture-classification MLP** (see
[00_backend_findings.md](00_backend_findings.md) §8). Gestures are geometric,
derived from the per-frame signals `HandTrackingService` already emits
(`isPinching`, `isFist`, `isHandOpen`, cursor `x/y`). SmartMirror re-broadcasts
that payload as a `smartMirror:hand` `CustomEvent`; the wardrobe recognizer
([gestureMap.js](../../src/widgets/Wardrobe/gestureMap.js)) listens to it. No new
camera is mounted (the mirror keeps a single `HandTrackingService`).

## The one new gesture class — `wardrobe_invoke`

`wardrobe_invoke` is the only added gesture. It is implemented as an **open-palm
dwell (~900 ms)** — hold an open hand toward the mirror to summon the widget
hands-free. This is the geometric equivalent of "add one class" without a model.

## Full action mapping

| Action | Gesture | How it's recognized | Reuses |
|---|---|---|---|
| `wardrobe_invoke` | open-palm dwell (~900 ms) | `isHandOpen` sustained | new geometric gesture |
| `next_outfit` | horizontal swipe | fast `x` displacement (open hand) | geometric |
| `dismiss` | fist dwell (~700 ms) | `isFist` sustained | existing fist signal |
| `render_vton` | pinch the "Try it on" target | the mirror's existing pinch-to-click | existing pinch/click |
| `feedback_up` | pinch the "Like" target | existing pinch-to-click | existing pinch/click |
| `feedback_down` | pinch the "Not for me" target | existing pinch-to-click | existing pinch/click |

`render_vton` / `feedback_*` are on-screen `<button>` targets activated by the
mirror's existing pinch-to-click (`SmartMirror.handleHandPosition`), so they need
no new recognition logic — they're wired to `onClick`. Only the three hands-free
gestures (`wardrobe_invoke`, `next_outfit`, `dismiss`) are recognized in
`gestureMap.js`, with a 1.2 s cooldown to suppress repeats.

State gating (in [index.jsx](../../src/widgets/Wardrobe/index.jsx)):
`wardrobe_invoke` only fires from `idle`; `next_outfit` only from `showing_board`;
`dismiss` from any non-idle state.

## Optional: a learned classifier (`tools/gesture_recapture.py`)

If the team later wants a *learned* gesture instead of the geometric dwell,
[tools/gesture_recapture.py](../../tools/gesture_recapture.py) is a runnable
scaffold (it is **not** required and is **not** run here): it records 50–100
labeled hand-landmark samples per member for the new gesture and trains a small
MLP **head** on the 21×3 MediaPipe landmarks, exporting `wardrobe_gesture.json`.
Because the mirror has no feature-extractor model to freeze, the "freeze the
extractor, retrain the head" instruction maps to: keep MediaPipe Hands as the
fixed feature extractor (it already outputs landmarks) and train only the small
head on top. Wiring such a model into the live pipeline would be a follow-up; the
shipped widget uses the geometric recognizer above.
