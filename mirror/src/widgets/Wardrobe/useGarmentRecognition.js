// "Do I already own this?" — ambient garment recognition. Runs only while the
// wardrobe widget is idle (not mid-outfit-browse or try-on), and only reacts to
// the mirror's existing pose-presence signal (see poseTracking.js) rather than
// polling every camera frame regardless of whether anyone is there.
//
// One decision per presence session: once someone has been stably present long
// enough to capture and check, the result (recognized / unknown+prompt) is
// final until they leave and a NEW person is stably present again. No image is
// captured, sent, or stored for the "is this known?" check to happen at all —
// see wardrobeApi.recognizeGarment, which never persists anything server-side —
// and nothing is EVER written to the wardrobe until the user explicitly
// confirms (see confirm/enroll below); recognizeGarment cannot create an item.
import { useEffect, useRef, useState } from 'react';
import { getCameraVideo } from '../../services/cameraStream';
import { startPoseTracking, stopPoseTracking } from '../../services/poseTracking';
import { torsoBounds } from './garmentLayer';
import { wardrobeApi } from './wardrobeApi';

const STABLE_MS = 1200;        // continuous visible presence required before capturing
const BURST_FRAMES = 3;        // frames combined into one decision
const BURST_INTERVAL_MS = 350;
const ABSENCE_RESET_MS = 2500; // presence lost this long -> next visit is a new session
const PROMPT_TIMEOUT_MS = 15000; // no response -> treat as declined, don't keep asking

function captureTorsoCrop(video, landmarks) {
  const bounds = torsoBounds(landmarks); // throws if the torso isn't visible
  const canvas = document.createElement('canvas');
  const padX = (bounds.right - bounds.left) * 0.25, padY = (bounds.bottom - bounds.top) * 0.15;
  const left = Math.max(0, bounds.left - padX), top = Math.max(0, bounds.top - padY);
  const right = Math.min(1, bounds.right + padX), bottom = Math.min(1, bounds.bottom + padY);
  const sx = left * video.videoWidth, sy = top * video.videoHeight;
  const sw = (right - left) * video.videoWidth, sh = (bottom - top) * video.videoHeight;
  canvas.width = Math.max(1, Math.round(sw)); canvas.height = Math.max(1, Math.round(sh));
  canvas.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('Cannot capture a garment frame.'))),
    'image/jpeg', 0.9,
  ));
}

export function useGarmentRecognition({ enabled }) {
  // 'idle' | 'checking' | 'recognized' | 'confirming' | 'enrolling' | 'added'
  const [phase, setPhase] = useState('idle');
  const [result, setResult] = useState(null); // recognized item, or the pending confirm frame
  const stateRef = useRef({ decided: false, lastVisibleAt: 0, stableSince: null, running: false });
  // The pose callback below is registered once per `enabled` toggle (mounting a
  // fresh MediaPipe tracker on every phase change would be wasteful/disruptive),
  // so it can't read `phase` from its own closure without seeing a stale value —
  // mirror it into a ref that's always current instead.
  const phaseRef = useRef(phase);
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  useEffect(() => {
    if (!enabled) { setPhase('idle'); setResult(null); return; }
    const video = getCameraVideo();
    if (!video) return;
    let stopped = false;
    // Fresh session every time recognition (re)starts — e.g. the widget went
    // idle->browsing->idle in between, which could span a real presence
    // changeover we had no camera signal for while paused.
    stateRef.current = { decided: false, lastVisibleAt: 0, stableSince: null, running: false };
    const st = stateRef.current;

    const runCheck = async (landmarks) => {
      st.running = true;
      setPhase('checking');
      try {
        const frames = [];
        for (let i = 0; i < BURST_FRAMES; i++) {
          if (stopped) return;
          frames.push(await captureTorsoCrop(video, landmarks));
          if (i < BURST_FRAMES - 1) await new Promise((r) => setTimeout(r, BURST_INTERVAL_MS));
        }
        if (stopped) return;
        const res = await wardrobeApi.recognizeGarment(frames);
        if (stopped) return;
        if (res.status === 'recognized') {
          setPhase('recognized'); setResult({ item: res.item, similarity: res.similarity });
        } else if (res.status === 'unknown') {
          setPhase('confirming'); setResult({ frame: frames[0] });
          setTimeout(() => {
            // No response within the window: one prompt per session, per spec —
            // treat silence as decline and go quiet until the person leaves.
            if (!stopped && stateRef.current.decided === false) { setPhase('idle'); setResult(null); }
          }, PROMPT_TIMEOUT_MS);
        } else {
          setPhase('idle'); // 'unavailable' — recognition not configured; fail quiet, not noisy
        }
      } catch (e) {
        console.error('DEBUG2', e);
        setPhase('idle');
      } finally {
        st.running = false;
      }
    };

    const handle = startPoseTracking(video, (pose) => {
      if (stopped) return;
      const now = Date.now();
      if (!pose.visible) {
        if (now - st.lastVisibleAt > ABSENCE_RESET_MS) { st.decided = false; st.stableSince = null; }
        return;
      }
      st.lastVisibleAt = now;
      if (st.stableSince === null) st.stableSince = now;
      if (st.decided || st.running || phaseRef.current !== 'idle') return;
      if (now - st.stableSince >= STABLE_MS) {
        st.decided = true; // one decision per presence session, from here
        runCheck(pose.landmarks);
      }
    });

    return () => { stopped = true; stopPoseTracking(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const confirm = async (accepted) => {
    stateRef.current.decided = true; // silences the timeout fallback above
    if (!accepted || !result?.frame) { setPhase('idle'); setResult(null); return; }
    setPhase('enrolling');
    try {
      const res = await wardrobeApi.enrollGarment(result.frame);
      setPhase('added'); setResult({ item: res.item });
      setTimeout(() => { setPhase('idle'); setResult(null); }, 6000);
    } catch (err) {
      setPhase('idle'); setResult(null);
      console.warn('[GarmentRecognition] enroll failed:', err.message);
    }
  };

  return { phase, result, confirm };
}
