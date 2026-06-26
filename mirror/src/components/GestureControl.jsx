import { useRef, useState, useCallback } from 'react';
import HandTrackingService from './HandTrackingService';
import CursorOverlay from './CursorOverlay';
import { getAppSettings } from '../data/apps';

// ── Gesture cursor for non-mirror pages (Settings, pairing/linking) ───────────
// Runs MediaPipe hand tracking WITHOUT the face-recognition model (onFaceDetected
// is intentionally omitted) and turns a pinch into a left-click at the cursor:
//   • pinch start  → remember cursor position
//   • pinch release → if the cursor barely moved, click that element
// Clicking a text field focuses it, which makes the global VirtualKeyboard appear.
//
// Only one HandTrackingService is ever mounted at a time because these pages and
// the mirror are mutually-exclusive routes, so there is no camera contention.

const CLICK_MOVE_TOLERANCE_PX = 70; // a pinch that drifts more than this is a drag, not a click
const SCROLL_ACTIVATE_PX = 14;      // vertical pinch-drag beyond this switches to scroll mode
const SCROLL_SPEED = 3;             // multiplier so small hand movements scroll a meaningful distance

// Nearest scrollable ancestor of an element (falls back to the document).
function getScrollableAncestor(el) {
  let node = el;
  while (node && node.nodeType === 1 && node !== document.body && node !== document.documentElement) {
    const oy = getComputedStyle(node).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

export default function GestureControl() {
  const cursorPositionRef = useRef({ x: 0, y: 0, detected: false });
  const detectedRef = useRef(false);
  const [detected, setDetected] = useState(false);
  const prevPinchRef = useRef(false);
  const pinchStartRef = useRef(null);
  const scrollTargetRef = useRef(null);
  const lastYRef = useRef(0);
  const isScrollingRef = useRef(false);
  const [settings] = useState(() => getAppSettings('handtracking'));

  const performClick = useCallback((x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return;
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'video' || tag === 'canvas') return;
    const target =
      el.closest('button, a, input, textarea, select, label, [role="button"], [data-vk-key]') || el;
    const ttag = target.tagName ? target.tagName.toLowerCase() : '';
    if (ttag === 'input' || ttag === 'textarea' || ttag === 'select') {
      try { target.focus({ preventScroll: true }); } catch { /* ignore */ }
    }
    try { target.click(); } catch { /* ignore restricted elements */ }
  }, []);

  const handleHandPosition = useCallback((position) => {
    cursorPositionRef.current = position;
    if (position.detected !== detectedRef.current) {
      detectedRef.current = position.detected;
      setDetected(position.detected);
    }

    const pinching = !!(position.detected && position.isPinching);

    // Pinch start — remember the origin and the scrollable element under the cursor.
    if (pinching && !prevPinchRef.current) {
      pinchStartRef.current = { x: position.x, y: position.y };
      lastYRef.current = position.y;
      isScrollingRef.current = false;
      const el = document.elementFromPoint(position.x, position.y);
      scrollTargetRef.current = el
        ? getScrollableAncestor(el)
        : (document.scrollingElement || document.documentElement);
    }

    // Pinch held — once it drifts vertically, drag-to-scroll the page.
    if (pinching && prevPinchRef.current && pinchStartRef.current) {
      if (!isScrollingRef.current &&
          Math.abs(position.y - pinchStartRef.current.y) > SCROLL_ACTIVATE_PX) {
        isScrollingRef.current = true;
      }
      if (isScrollingRef.current && scrollTargetRef.current) {
        // Grab-and-drag: hand moves down → content follows down (like a touchscreen).
        const delta = (position.y - lastYRef.current) * SCROLL_SPEED;
        scrollTargetRef.current.scrollTop -= delta;
      }
      lastYRef.current = position.y;
    }

    // Pinch release — click only if it was a tap, not a scroll/drag.
    if (!pinching && prevPinchRef.current && pinchStartRef.current) {
      const start = pinchStartRef.current;
      const endX = Number.isFinite(position.x) ? position.x : start.x;
      const endY = Number.isFinite(position.y) ? position.y : start.y;
      const moved = Math.hypot(endX - start.x, endY - start.y);
      if (!isScrollingRef.current && moved < CLICK_MOVE_TOLERANCE_PX) {
        performClick(start.x, start.y);
      }
      pinchStartRef.current = null;
      isScrollingRef.current = false;
      scrollTargetRef.current = null;
    }

    prevPinchRef.current = pinching;
  }, [performClick]);

  return (
    <>
      <HandTrackingService
        onHandPosition={handleHandPosition}
        onFaceDetected={undefined}
        settings={settings}
        enabled
      />
      <CursorOverlay
        positionRef={cursorPositionRef}
        isVisible={detected}
        isDragging={false}
        variant="default"
      />
    </>
  );
}
