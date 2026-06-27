// Maps gesture classes to wardrobe actions and recognizes them from the existing
// MediaPipe hand stream. There is no gesture MLP in this project (see
// docs/wardrobe/00_backend_findings.md §8) — gestures are geometric, derived from
// the signals HandTrackingService already emits and re-broadcast by SmartMirror
// as a 'smartMirror:hand' CustomEvent.
//
// Action set (documented in docs/wardrobe/wardrobe_gestures.md):
//   wardrobe_invoke  open-palm dwell (~900ms)      hands-free summon
//   next_outfit      horizontal swipe              cycle candidates
//   dismiss          fist dwell (~700ms)           close
//   render_vton      pinch the "try on" target     (existing pinch-click)
//   feedback_up      pinch the thumb-up target     (existing pinch-click)
//   feedback_down    pinch the thumb-down target   (existing pinch-click)
//
// render_vton / feedback_* are on-screen targets activated by the mirror's
// existing pinch-to-click, so they aren't recognized here — they're wired to
// button onClick in the widget. This module recognizes the three hands-free
// geometric gestures.

export const GESTURE_MAP = {
  wardrobe_invoke: { source: 'open-palm dwell', kind: 'hands-free' },
  next_outfit: { source: 'horizontal swipe', kind: 'hands-free' },
  dismiss: { source: 'fist dwell', kind: 'hands-free' },
  render_vton: { source: 'pinch try-on target', kind: 'pinch-click' },
  feedback_up: { source: 'pinch thumb-up target', kind: 'pinch-click' },
  feedback_down: { source: 'pinch thumb-down target', kind: 'pinch-click' },
};

const OPEN_DWELL_MS = 900;
const FIST_DWELL_MS = 700;
const SWIPE_MIN_DX = 0.18; // fraction of screen width
const SWIPE_MAX_MS = 500;
const COOLDOWN_MS = 1200; // suppress repeats after firing any gesture

/**
 * Subscribes to the hand stream and invokes handlers when a gesture is detected.
 * @param {{ onInvoke?:fn, onNext?:fn, onDismiss?:fn, enabled?:()=>boolean }} handlers
 * @returns {() => void} unsubscribe
 */
export function createGestureRecognizer(handlers = {}) {
  let openSince = null;
  let fistSince = null;
  let swipeStart = null; // { x, t }
  let lastFire = 0;
  // Edge-detection latches: a dwell gesture fires ONCE, then can't fire again
  // until the hand LEAVES the frame (detected=false) and returns. Re-arming only
  // when the hand leaves — not when the pose merely changes — is deliberate:
  // closing the widget is a pinch-click, which momentarily drops the open-palm
  // pose; if that re-armed invoke, the still-raised hand would instantly
  // re-summon the widget in a loop. So a fresh summon needs the hand lowered and
  // raised again.
  let openArmed = true;
  let fistArmed = true;

  const fire = (name, fn) => {
    const now = Date.now();
    if (now - lastFire < COOLDOWN_MS) return;
    lastFire = now;
    openSince = fistSince = swipeStart = null;
    if (typeof fn === 'function') fn(name);
  };

  const onHand = (e) => {
    if (handlers.enabled && !handlers.enabled()) return;
    const p = e.detail || {};
    const now = Date.now();

    if (!p.detected) {
      openSince = fistSince = swipeStart = null;
      openArmed = fistArmed = true; // hand left the frame -> re-arm both
      return;
    }

    // Open-palm dwell -> invoke. Fires once until the hand leaves the frame.
    if (p.isHandOpen) {
      openSince = openSince ?? now;
      if (openArmed && now - openSince >= OPEN_DWELL_MS) {
        openArmed = false; // latched until detected=false re-arms it
        return fire('wardrobe_invoke', handlers.onInvoke);
      }
    } else {
      openSince = null;
    }

    // Fist dwell -> dismiss. Fires once until the hand leaves the frame.
    if (p.isFist) {
      fistSince = fistSince ?? now;
      if (fistArmed && now - fistSince >= FIST_DWELL_MS) {
        fistArmed = false; // latched until detected=false re-arms it
        return fire('dismiss', handlers.onDismiss);
      }
    } else {
      fistSince = null;
    }

    // Horizontal swipe (open hand moving fast) -> next outfit.
    const nx = typeof p.x === 'number' ? p.x / window.innerWidth : null;
    if (nx !== null && !p.isFist && !p.isPinching) {
      if (!swipeStart) {
        swipeStart = { x: nx, t: now };
      } else if (now - swipeStart.t > SWIPE_MAX_MS) {
        swipeStart = { x: nx, t: now };
      } else if (Math.abs(nx - swipeStart.x) >= SWIPE_MIN_DX) {
        return fire('next_outfit', handlers.onNext);
      }
    } else {
      swipeStart = null;
    }
  };

  window.addEventListener('smartMirror:hand', onHand);
  return () => window.removeEventListener('smartMirror:hand', onHand);
}
