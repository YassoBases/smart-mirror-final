import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import DraggableApp from '../components/DraggableApp';
import CursorOverlay from '../components/CursorOverlay';
import HandTrackingService from '../components/HandTrackingService';
import AIAssistantOverlay from '../components/AIAssistantOverlay';
import { apps, getAppSettings } from '../data/apps';
import { getGeneralSettings, getAccentOption, getFontOption } from '../data/generalSettings';
import { useAIAssistant } from '../hooks/useAIAssistant';
import useActiveUser from '../hooks/useActiveUser';
import useFaceEnrollment from '../hooks/useFaceEnrollment';
import { findUserByFace, findBestFaceDistance, saveFaceDescriptor, getUsers, setActiveUser } from '../data/users';
import { useProfile } from '../contexts/ProfileContext';
import { backendApi } from '../services/backendApi';

// Import all app components
import DateTimeApp from '../apps/DateTimeApp';
import WeatherApp from '../apps/WeatherApp';
import NewsApp from '../apps/NewsApp';
import SpotifyApp from '../apps/spotify/App';
import GmailApp from '../apps/gmail/GmailApp';
import WardrobeWidget from '../widgets/Wardrobe';

const RESIZE_ZONE = 60;           // px from bottom-right corner that triggers gesture resize
const DRAG_COMMIT_TIME_MS = 500;  // ms of sustained pinch before committing to drag/resize
const DRAG_COMMIT_DISTANCE_PX = 20; // px of movement before committing (whichever comes first)
const CLICK_MAX_MOVE_PX = 60;    // px — abort click if hand moved more than this

// Walk up the DOM from el to find the nearest interactive element (button, a, etc.)
function findClickTarget(el) {
  let cur = el;
  while (cur && cur !== document.body) {
    const tag = cur.tagName?.toLowerCase();
    if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'label') {
      return cur;
    }
    if (cur.getAttribute('role') === 'button') return cur;
    cur = cur.parentElement;
  }
  return el;
}

const hexToRgba = (hex, alpha) => {
  if (!hex) {
    return `rgba(255, 255, 255, ${alpha})`;
  }

  let normalized = hex.replace('#', '');
  if (normalized.length === 3) {
    normalized = normalized.split('').map(char => char + char).join('');
  }

  const bigint = parseInt(normalized, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;

  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const SmartMirror = () => {
  // ── AI assistant (new unified hook) ──────────────────────────────────────
  const assistant = useAIAssistant();

  // ── Central profile state (backend → settings/integrations/location) ──────
  const { activeProfile } = useProfile();

  // ── Active user (synced from phone via backend polling) ───────────────────
  const { activeUser } = useActiveUser();

  // ── Face enrollment — loads backend face photos → computes descriptors ────
  useFaceEnrollment();

  // ── Mirror UI state ───────────────────────────────────────────────────────
  const [enabledApps, setEnabledApps] = useState([]);
  const [generalSettings, setGeneralSettings] = useState(() => getGeneralSettings());
  // Ref mirrors generalSettings so callbacks read latest value without being re-created
  const generalSettingsRef = useRef(generalSettings);
  const containerRef = useRef(null);
  const cursorPositionRef  = useRef({ x: 0, y: 0, detected: false });
  const cursorDetectedRef  = useRef(false);
  const [isHandDetected, setIsHandDetected] = useState(false);
  const lastHoverCheckRef  = useRef(0);
  const lastSleepResetRef  = useRef(0);
  const [handTrackingEnabled, setHandTrackingEnabled] = useState(true); // start true — camera needed for face recognition from first frame
  const [isDragging, setIsDragging] = useState(false);
  const [dragTarget, setDragTarget] = useState(null);
  const dragTargetRef = useRef(null);
  const [appPositions, setAppPositions] = useState({});
  const [isResizing, setIsResizing] = useState(false);
  const [resizeTarget, setResizeTarget] = useState(null);
  const resizeTargetRef = useRef(null);
  const [appSizes, setAppSizes] = useState({});
  const handTrackingSettingsRef = useRef(null); // cached hand tracking settings
  const prevIsPinchingRef = useRef(false);
  const pinchStartTimeRef = useRef(null);
  const pinchStartPositionRef = useRef(null);
  const pinchTargetRef = useRef(null); // { element, inResizeZone } captured at pinch start
  const pinchMaxMoveRef = useRef(0);   // max px moved since pinch started (pending phase)
  const [hoveredAppId, setHoveredAppId] = useState(null);
  const [activeWidgetId, setActiveWidgetId] = useState(null);
  const [sleepState, setSleepState] = useState('awake');
  const [wakeCircle, setWakeCircle] = useState(null);
  const sleepTimerRef = useRef(null);
  const sleepStateRef = useRef('awake');
  const wakeGestureStageRef = useRef('idle');
  const wakeAwaitTimerRef = useRef(null);
  const sleepWakeTimerRef = useRef(null);
  const sleepWakeLastPositionRef = useRef(null);
  const [sleepWakeCursorVisible, setSleepWakeCursorVisible] = useState(false);

  // ── Face recognition state ────────────────────────────────────────────────
  // lockedFaceUser: the user currently locked in via face recognition (null = no face seen yet)
  // faceStatus: 'idle' | 'scanning' | 'recognized' | 'unknown'
  const [lockedFaceUser, setLockedFaceUser] = useState(null);
  const [faceStatus, setFaceStatus] = useState('idle');
  const lockedFaceUserRef = useRef(null);
  // Throttle: epoch ms of last unknown-face alert sent (null = never)
  const lastUnknownAlertRef = useRef(null);
  const UNKNOWN_ALERT_COOLDOWN_MS = 3 * 60 * 1000; // 3 min between unknown-face push alerts
  // Require several consecutive unknown detections before flagging, so a single
  // borderline frame (e.g. the owner scoring just over the match threshold) does
  // not blast a phone notification.
  const consecutiveUnknownCountRef = useRef(0);
  const UNKNOWN_CONFIRM_COUNT = 3; // ~4.5 s of continuous unknown at the 1.5 s sample interval
  // Tracks how many consecutive null-detection frames before we consider the face "gone"
  const faceMissCountRef = useRef(0);
  const FACE_MISS_THRESHOLD = 4; // ~6 seconds at 1.5s interval before considering face left
  // Consecutive-match confirmation: require 2 detections in a row before switching user
  const consecutiveMatchCountRef = useRef(0);
  const lastMatchedUserIdRef = useRef(null);

  useEffect(() => {
    sleepStateRef.current = sleepState;
  }, [sleepState]);

  useEffect(() => {
    generalSettingsRef.current = generalSettings;
  }, [generalSettings]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const accent = getAccentOption(generalSettings.accent);
    const font = getFontOption(generalSettings.font);
    const isNoAccent = generalSettings.accent === 'none';
    const accentSoft = hexToRgba(accent.glow || accent.color, isNoAccent ? 0 : 0.45);
    const accentGlow = hexToRgba(accent.color, isNoAccent ? 0 : 0.22);
    const accentHalo = hexToRgba(accent.color, isNoAccent ? 0 : 0.38);

    const root = document.documentElement;
    root.style.setProperty('--mirror-accent-color', isNoAccent ? 'rgba(255,255,255,0.18)' : accent.color);
    root.style.setProperty('--mirror-accent-soft', accentSoft);
    root.style.setProperty('--mirror-font-family', font.stack);
    root.style.setProperty(
      '--mirror-widget-border',
      generalSettings.widgetBorders ? '1px solid rgba(255, 255, 255, 0.18)' : '0px solid transparent'
    );
    root.style.setProperty(
      '--mirror-widget-shadow',
      generalSettings.widgetShadows ? `0 22px 45px ${accentGlow}, 0 0 30px ${accentHalo}` : 'none'
    );
    root.style.setProperty(
      '--mirror-widget-shadow-strong',
      generalSettings.widgetShadows ? `0 0 32px ${accentHalo}` : 'none'
    );
  }, [generalSettings]);



  const clearDragState = useCallback(() => {
    // Clear all app highlights first
    const allApps = document.querySelectorAll('[data-app-id]');
    allApps.forEach(app => {
      app.style.transition = '';
      app.style.boxShadow = '';
      app.style.transform = '';
      app.style.zIndex = '';
      app.style.pointerEvents = '';
    });

    setIsDragging(false);
    setDragTarget(null);
    dragTargetRef.current = null; // Clear ref immediately
    // Don't clear appPositions here as they need to persist for the final save
  }, []);

  const clearResizeState = useCallback(() => {
    if (resizeTargetRef.current?.element) {
      const el = resizeTargetRef.current.element;
      el.style.transition = '';
      el.style.boxShadow = '';
    }
    setIsResizing(false);
    setResizeTarget(null);
    resizeTargetRef.current = null;
  }, []);

  const resetSleepTimer = useCallback(() => {
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
      sleepTimerRef.current = null;
    }

    if (!generalSettings.mirrorTimeoutEnabled) {
      return;
    }

    const minutes = Number(generalSettings.mirrorTimeoutMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return;
    }

    if (sleepStateRef.current !== 'awake') {
      return;
    }

    const delay = Math.max(1, Math.round(minutes)) * 60 * 1000;

    sleepTimerRef.current = setTimeout(() => {
      if (sleepStateRef.current !== 'awake') {
        return;
      }

      sleepTimerRef.current = null;
      sleepStateRef.current = 'sleeping';
      clearDragState();
      setHoveredAppId(null);
      cursorPositionRef.current = { ...cursorPositionRef.current, detected: false };
      cursorDetectedRef.current = false;
      setIsHandDetected(false);
      setSleepState('sleeping');
      setWakeCircle(null);
      wakeGestureStageRef.current = 'idle';
      setSleepWakeCursorVisible(false);
      sleepWakeLastPositionRef.current = null;
      if (sleepWakeTimerRef.current) {
        clearTimeout(sleepWakeTimerRef.current);
        sleepWakeTimerRef.current = null;
      }
      if (wakeAwaitTimerRef.current) {
        clearTimeout(wakeAwaitTimerRef.current);
        wakeAwaitTimerRef.current = null;
      }
    }, delay);
  }, [clearDragState, generalSettings.mirrorTimeoutEnabled, generalSettings.mirrorTimeoutMinutes]);

  const wakeMirror = useCallback((origin) => {
    if (sleepStateRef.current !== 'sleeping') {
      return;
    }

    if (sleepWakeTimerRef.current) {
      clearTimeout(sleepWakeTimerRef.current);
      sleepWakeTimerRef.current = null;
    }

    sleepWakeLastPositionRef.current = null;
    setSleepWakeCursorVisible(false);

    sleepStateRef.current = 'waking';
    setSleepState('waking');
    setWakeCircle(prev => (prev ? { ...prev, x: origin.x, y: origin.y } : { x: origin.x, y: origin.y, strength: 0 }));
    wakeGestureStageRef.current = 'animating';

    if (wakeAwaitTimerRef.current) {
      clearTimeout(wakeAwaitTimerRef.current);
      wakeAwaitTimerRef.current = null;
    }

    const appElements = document.querySelectorAll('[data-app-id]');
    appElements.forEach(element => {
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const translateX = origin.x - centerX;
      const translateY = origin.y - centerY;

      element.animate(
        [
          { transform: `translate(${translateX}px, ${translateY}px) scale(0.7)`, opacity: 0 },
          { transform: 'translate(0px, 0px) scale(1)', opacity: 1 }
        ],
        {
          duration: 420,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
        }
      );
    });

    setTimeout(() => {
      wakeGestureStageRef.current = 'idle';
      setWakeCircle(null);
      sleepStateRef.current = 'awake';
      setSleepState('awake');
      resetSleepTimer();
    }, 440);
  }, [resetSleepTimer]);

  useEffect(() => {
    if (!generalSettings.mirrorTimeoutEnabled) {
      if (sleepTimerRef.current) {
        clearTimeout(sleepTimerRef.current);
        sleepTimerRef.current = null;
      }
      if (wakeAwaitTimerRef.current) {
        clearTimeout(wakeAwaitTimerRef.current);
        wakeAwaitTimerRef.current = null;
      }
      if (sleepStateRef.current !== 'awake') {
        sleepStateRef.current = 'awake';
        setSleepState('awake');
      }
      setWakeCircle(null);
      wakeGestureStageRef.current = 'idle';
      return;
    }

    resetSleepTimer();
  }, [generalSettings.mirrorTimeoutEnabled, generalSettings.mirrorTimeoutMinutes, resetSleepTimer]);

  useEffect(() => {
    if (!generalSettings.mirrorTimeoutEnabled) {
      return undefined;
    }

    const handleActivity = () => {
      if (sleepStateRef.current === 'awake') {
        resetSleepTimer();
      }
    };

    const events = ['mousemove', 'keydown', 'pointerdown', 'touchstart'];
    events.forEach(event => window.addEventListener(event, handleActivity));

    return () => {
      events.forEach(event => window.removeEventListener(event, handleActivity));
    };
  }, [generalSettings.mirrorTimeoutEnabled, resetSleepTimer]);

  useEffect(() => () => {
    if (sleepTimerRef.current) {
      clearTimeout(sleepTimerRef.current);
    }
    if (wakeAwaitTimerRef.current) {
      clearTimeout(wakeAwaitTimerRef.current);
    }
    if (sleepWakeTimerRef.current) {
      clearTimeout(sleepWakeTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (sleepState === 'awake') {
      setSleepWakeCursorVisible(false);
      sleepWakeLastPositionRef.current = null;
      if (sleepWakeTimerRef.current) {
        clearTimeout(sleepWakeTimerRef.current);
        sleepWakeTimerRef.current = null;
      }
    }
  }, [sleepState]);

  // ── Widget list — local settings always win; backend adds integration widgets ─
  useEffect(() => {
    const evaluateWidgets = () => {
      const localSettings = JSON.parse(localStorage.getItem('smartMirrorSettings') || '{}');
      // An app is locally enabled when its enabled flag is absent (never set) or true
      const localEnabled = (appId) => localSettings[appId]?.enabled !== false;

      const visible = apps.filter(app => {
        if (app.isBackgroundService) return false;

        // All widgets — including Gmail & Spotify — follow the phone toggle.
        // OAuth connection status (integrations.*) does NOT gate visibility; it only
        // controls whether each widget shows live data or its own "not connected"
        // placeholder, which GmailApp/SpotifyApp render internally.
        return localEnabled(app.id);
      });

      setEnabledApps(visible);
      setGeneralSettings(getGeneralSettings());

      const htSettings = getAppSettings('handtracking');
      handTrackingSettingsRef.current = htSettings;
      const htEnabled = htSettings.enabled !== false;
      setHandTrackingEnabled(htEnabled);
      const s = getGeneralSettings();
      if (htEnabled && s.faceRecognitionEnabled) setFaceStatus('scanning');
    };

    evaluateWidgets();
    // Re-evaluate whenever Settings page saves a change
    window.addEventListener('storage', evaluateWidgets);
    return () => window.removeEventListener('storage', evaluateWidgets);
  }, [activeProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Test hook — open browser console and call window.__testUnknownFace() ────
  useEffect(() => {
    window.__testUnknownFace = () => {
      const mirrorId = backendApi.getMirrorId();
      if (!mirrorId) { console.warn('[Mirror] No mirrorId — cannot send test alert'); return; }
      backendApi.reportUnknownFace(mirrorId, { confidence: 0.72 });
      console.log('[Mirror] Test unknown-face alert fired for mirror:', mirrorId);
    };
    return () => { delete window.__testUnknownFace; };
  }, []);

  const handleFaceDetected = useCallback((faceResult) => {
    if (!faceResult) {
      faceMissCountRef.current += 1;
      if (faceMissCountRef.current >= FACE_MISS_THRESHOLD) {
        setFaceStatus('scanning');
        consecutiveMatchCountRef.current = 0;
        lastMatchedUserIdRef.current = null;
        consecutiveUnknownCountRef.current = 0;
      }
      return;
    }

    faceMissCountRef.current = 0;
    const { descriptor, captureSnapshot } = faceResult;
    const match = findUserByFace(descriptor);

    if (match) {
      const { user } = match;
      if (!user) return;
      consecutiveUnknownCountRef.current = 0; // a real match clears any unknown streak

      // Consecutive-match confirmation: require 2 detections before switching
      if (lastMatchedUserIdRef.current === user.id) {
        consecutiveMatchCountRef.current = Math.min(consecutiveMatchCountRef.current + 1, 10);
      } else {
        lastMatchedUserIdRef.current = user.id;
        consecutiveMatchCountRef.current = 1;
      }

      if (lockedFaceUserRef.current?.id !== user.id && consecutiveMatchCountRef.current < 2) {
        setFaceStatus('scanning'); // first match — wait for confirmation
        return;
      }

      if (lockedFaceUserRef.current?.id !== user.id) {
        lockedFaceUserRef.current = user;
        setLockedFaceUser(user);
        setActiveUser(user.id);

        // Notify the backend so settings sync picks up this user
        if (user.backendId) {
          const mirrorId = backendApi.getMirrorId();
          backendApi.setActiveMirrorUser(mirrorId, user.backendId);
          console.log('[Mirror] Face recognised — switched to:', user.name);
        }
      }
      setFaceStatus('recognized');
    } else {
      // Only auto-enroll local (non-phone) profiles that have no descriptor yet
      const { profiles } = getUsers();
      const unregistered = profiles.find(p => {
        if (p.source === 'phone') return false; // phone profiles enroll via the app
        const stored = JSON.parse(localStorage.getItem('smartMirrorSettings') || '{}');
        return !stored.faceDescriptors?.[p.id];
      });

      if (unregistered && !lockedFaceUserRef.current) {
        saveFaceDescriptor(unregistered.id, descriptor);
        lockedFaceUserRef.current = unregistered;
        setLockedFaceUser(unregistered);
        setActiveUser(unregistered.id);
        setFaceStatus('recognized');
      } else {
        // Need several consecutive unknown frames before we trust it and alert.
        consecutiveUnknownCountRef.current += 1;
        if (consecutiveUnknownCountRef.current < UNKNOWN_CONFIRM_COUNT) {
          setFaceStatus('scanning'); // still unsure — keep scanning before flagging
          return;
        }

        if (lockedFaceUserRef.current?.id !== 'unknown') {
          lockedFaceUserRef.current = { id: 'unknown', name: 'Unknown' };
          setLockedFaceUser({ id: 'unknown', name: 'Unknown' });

          // Send alert — throttled by UNKNOWN_ALERT_COOLDOWN_MS
          const now = Date.now();
          if (!lastUnknownAlertRef.current || now - lastUnknownAlertRef.current > UNKNOWN_ALERT_COOLDOWN_MS) {
            lastUnknownAlertRef.current = now;
            const mirrorId = backendApi.getMirrorId();
            if (mirrorId) {
              const confidence = findBestFaceDistance(descriptor);
              const imageData = typeof captureSnapshot === 'function' ? captureSnapshot() : null;
              backendApi.reportUnknownFace(mirrorId, { confidence, imageData });
            }
          }
        }
        setFaceStatus('unknown');
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleHandPosition = (position) => {
    // Update ref without triggering a React re-render; CursorOverlay reads this via RAF.
    cursorPositionRef.current = position;
    // Re-broadcast the raw hand payload so opt-in widgets (e.g. the Wardrobe
    // gesture recognizer) can detect hands-free gestures without a second camera.
    window.dispatchEvent(new CustomEvent('smartMirror:hand', { detail: position }));
    if (position.detected !== cursorDetectedRef.current) {
      cursorDetectedRef.current = position.detected;
      setIsHandDetected(position.detected);
    }

    if (sleepState !== 'awake') {
      if (sleepState === 'sleeping') {
        if (!position.detected) {
          setSleepWakeCursorVisible(false);
          sleepWakeLastPositionRef.current = null;
          if (sleepWakeTimerRef.current) {
            clearTimeout(sleepWakeTimerRef.current);
            sleepWakeTimerRef.current = null;
          }
          if (wakeAwaitTimerRef.current) {
            clearTimeout(wakeAwaitTimerRef.current);
            wakeAwaitTimerRef.current = null;
          }
          wakeGestureStageRef.current = 'idle';
          setWakeCircle(null);
          return;
        }

        const sanitizedPosition = {
          x: Number.isFinite(position.x) ? position.x : window.innerWidth / 2,
          y: Number.isFinite(position.y) ? position.y : window.innerHeight / 2
        };

        sleepWakeLastPositionRef.current = sanitizedPosition;
        setSleepWakeCursorVisible(true);

        if (!sleepWakeTimerRef.current) {
          wakeGestureStageRef.current = 'awaiting';
          sleepWakeTimerRef.current = setTimeout(() => {
            sleepWakeTimerRef.current = null;

            if (sleepStateRef.current !== 'sleeping') {
              setSleepWakeCursorVisible(false);
              sleepWakeLastPositionRef.current = null;
              wakeGestureStageRef.current = 'idle';
              return;
            }

            const finalPosition = sleepWakeLastPositionRef.current;
            const origin = {
              x: Number.isFinite(finalPosition?.x) ? finalPosition.x : window.innerWidth / 2,
              y: Number.isFinite(finalPosition?.y) ? finalPosition.y : window.innerHeight / 2
            };

            wakeMirror(origin);
          }, 3000);
        }
      }

      return;
    }

    if (generalSettings.mirrorTimeoutEnabled && position.detected) {
      const nowMs = performance.now();
      if (nowMs - lastSleepResetRef.current >= 1000) {
        lastSleepResetRef.current = nowMs;
        resetSleepTimer();
      }
    }

    if (!generalSettings.widgetHoverHighlight || !handTrackingEnabled) {
      if (hoveredAppId !== null) {
        setHoveredAppId(null);
      }
    } else if (position.detected) {
      const nowMs = performance.now();
      if (nowMs - lastHoverCheckRef.current >= 200) {
        lastHoverCheckRef.current = nowMs;
        const allApps = document.querySelectorAll('[data-app-id]');
        let targetAppId = null;
        let highestZIndex = -Infinity;

        allApps.forEach(app => {
          const rect = app.getBoundingClientRect();
          const isUnderCursor = position.x >= rect.left &&
            position.x <= rect.right &&
            position.y >= rect.top &&
            position.y <= rect.bottom;

          if (isUnderCursor) {
            const zIndex = parseInt(app.style.zIndex) || 0;
            if (zIndex >= highestZIndex) {
              highestZIndex = zIndex;
              targetAppId = app.dataset.appId;
            }
          }
        });

        if (targetAppId !== hoveredAppId) {
          setHoveredAppId(targetAppId);
        }
      }
    } else if (hoveredAppId !== null) {
      setHoveredAppId(null);
    }

    const isPinchingNow = position.detected && position.isPinching;

    // ── Pinch start — capture target app and zone ────────────────────────────
    if (isPinchingNow && !prevIsPinchingRef.current) {
      const allApps = document.querySelectorAll('[data-app-id]');
      let targetApp = null;
      let highestZIndex = -1;
      let inResizeZone = false;

      allApps.forEach(app => {
        const rect = app.getBoundingClientRect();
        const under = position.x >= rect.left && position.x <= rect.right &&
                      position.y >= rect.top  && position.y <= rect.bottom;
        if (under) {
          const zIndex = parseInt(app.style.zIndex) || 0;
          if (zIndex >= highestZIndex) {
            highestZIndex = zIndex;
            targetApp = app;
            inResizeZone = position.x >= rect.right  - RESIZE_ZONE &&
                           position.y >= rect.bottom - RESIZE_ZONE;
          }
        }
      });

      pinchStartTimeRef.current = Date.now();
      pinchStartPositionRef.current = { x: position.x, y: position.y };
      const canTargetMove = targetApp &&
        generalSettings.gestureEnabled &&
        targetApp.dataset.locked !== 'true';
      pinchTargetRef.current = canTargetMove ? { element: targetApp, inResizeZone } : null;
      pinchMaxMoveRef.current = 0;
    }

    // ── Track max movement during pending pinch ──────────────────────────────
    if (isPinchingNow && pinchStartPositionRef.current && !dragTargetRef.current && !resizeTargetRef.current) {
      const moved = Math.hypot(
        position.x - pinchStartPositionRef.current.x,
        position.y - pinchStartPositionRef.current.y
      );
      if (moved > pinchMaxMoveRef.current) pinchMaxMoveRef.current = moved;
    }

    // ── Commit pending pinch to drag/resize once threshold is exceeded ───────
    if (isPinchingNow && !dragTargetRef.current && !resizeTargetRef.current && pinchTargetRef.current) {
      const elapsed = Date.now() - (pinchStartTimeRef.current || 0);
      const shouldCommit = elapsed > DRAG_COMMIT_TIME_MS || pinchMaxMoveRef.current > DRAG_COMMIT_DISTANCE_PX;

      if (shouldCommit) {
        const { element: targetApp, inResizeZone } = pinchTargetRef.current;
        clearDragState();
        pinchTargetRef.current = null;

        if (inResizeZone) {
          setIsResizing(true);
          const rect = targetApp.getBoundingClientRect();
          const resizeTargetData = {
            appId: targetApp.dataset.appId,
            element: targetApp,
            startX: position.x,
            startY: position.y,
            initialWidth: targetApp.offsetWidth,
            initialHeight: targetApp.offsetHeight,
            rectLeft: rect.left,
            rectTop: rect.top,
          };
          setResizeTarget(resizeTargetData);
          resizeTargetRef.current = resizeTargetData;
          targetApp.style.transition = 'none';
          targetApp.style.boxShadow = '0 0 20px rgba(34, 197, 94, 0.8)';
          targetApp.style.zIndex = '1000';
        } else {
          setIsDragging(true);
          const rect = targetApp.getBoundingClientRect();
          const containerRect = containerRef.current?.getBoundingClientRect();
          const dragTargetData = {
            appId: targetApp.dataset.appId,
            element: targetApp,
            startX: position.x,
            startY: position.y,
            offsetX: position.x - rect.left,
            offsetY: position.y - rect.top,
            initialPosition: {
              x: containerRect ? rect.left - containerRect.left : rect.left,
              y: containerRect ? rect.top - containerRect.top : rect.top
            }
          };
          setDragTarget(dragTargetData);
          dragTargetRef.current = dragTargetData;
          targetApp.style.transition = 'none';
          targetApp.style.boxShadow = '0 0 20px rgba(59, 130, 246, 0.8)';
          targetApp.style.transform = 'none';
          targetApp.style.zIndex = '1000';
          targetApp.style.pointerEvents = 'none';
        }
      }
    }

    // ── Continue active resize — DOM only during drag, React state only on release ──
    if (isPinchingNow && resizeTargetRef.current) {
      const cur = resizeTargetRef.current;
      const newWidth  = Math.max(150, Math.min(window.innerWidth  - cur.rectLeft, cur.initialWidth  + (position.x - cur.startX)));
      const newHeight = Math.max(100, Math.min(window.innerHeight - cur.rectTop,  cur.initialHeight + (position.y - cur.startY)));
      if (cur.element) {
        cur.element.style.width  = `${newWidth}px`;
        cur.element.style.height = `${newHeight}px`;
      }
      cur._lastWidth  = newWidth;
      cur._lastHeight = newHeight;
    }

    // ── Continue active drag — DOM only during drag, React state only on release ──
    if (isPinchingNow && dragTargetRef.current) {
      const cur = dragTargetRef.current;
      const containerRect  = containerRef.current?.getBoundingClientRect();
      const containerWidth  = containerRect?.width  || window.innerWidth;
      const containerHeight = containerRect?.height || window.innerHeight;
      const newLeft = Math.max(0, Math.min(containerWidth  - (cur.element?.offsetWidth  || 300), cur.initialPosition.x + (position.x - cur.startX)));
      const newTop  = Math.max(0, Math.min(containerHeight - (cur.element?.offsetHeight || 200), cur.initialPosition.y + (position.y - cur.startY)));
      if (cur.element) {
        cur.element.style.left = `${newLeft}px`;
        cur.element.style.top  = `${newTop}px`;
      }
      cur._lastLeft = newLeft;
      cur._lastTop  = newTop;
    }

    // ── Pinch end ────────────────────────────────────────────────────────────
    if (!isPinchingNow && prevIsPinchingRef.current) {
      if (resizeTargetRef.current) {
        const rt = resizeTargetRef.current;
        const finalSize = {
          width:  rt._lastWidth  ?? rt.initialWidth,
          height: rt._lastHeight ?? rt.initialHeight
        };
        const existing = JSON.parse(localStorage.getItem(`smartMirror_${rt.appId}_layout`) || '{}');
        localStorage.setItem(`smartMirror_${rt.appId}_layout`, JSON.stringify({
          position: existing.position || { x: 0, y: 0 },
          size: finalSize,
          locked: existing.locked ?? false
        }));
        setAppSizes(prev => ({ ...prev, [rt.appId]: finalSize }));
        clearResizeState();
      } else if (dragTargetRef.current) {
        const dt = dragTargetRef.current;
        const finalPosition = {
          x: dt._lastLeft ?? dt.initialPosition.x,
          y: dt._lastTop  ?? dt.initialPosition.y
        };
        const existingLayout = JSON.parse(localStorage.getItem(`smartMirror_${dt.appId}_layout`) || '{}');
        localStorage.setItem(`smartMirror_${dt.appId}_layout`, JSON.stringify({
          position: { x: finalPosition.x, y: finalPosition.y },
          size: { width: dt.element?.offsetWidth || 300, height: dt.element?.offsetHeight || 200 },
          locked: existingLayout.locked ?? false
        }));
        setAppPositions(prev => ({ ...prev, [dt.appId]: finalPosition }));
        clearDragState();
      } else if (pinchStartTimeRef.current) {
        // No drag/resize committed — check for tap/click gesture
        const duration = Date.now() - pinchStartTimeRef.current;
        const clickMaxMs = handTrackingSettingsRef.current?.clickPinchMaxMs ?? 400;
        if (duration < clickMaxMs && pinchMaxMoveRef.current < CLICK_MAX_MOVE_PX) {
          const clickX = pinchStartPositionRef.current?.x ?? position.x;
          const clickY = pinchStartPositionRef.current?.y ?? position.y;
          const el = document.elementFromPoint(clickX, clickY);
          const tag = el?.tagName?.toLowerCase();
          if (el && tag !== 'video' && tag !== 'canvas') {
            const target = findClickTarget(el);
            // Focus text fields so the on-screen VirtualKeyboard appears.
            const ttag = target?.tagName?.toLowerCase();
            if (ttag === 'input' || ttag === 'textarea' || ttag === 'select') {
              try { target.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
            }
            try { target.click(); } catch (_) { /* ignore restricted elements */ }
          }
        }
      }

      pinchStartTimeRef.current = null;
      pinchStartPositionRef.current = null;
      pinchTargetRef.current = null;
      pinchMaxMoveRef.current = 0;
    }

    prevIsPinchingRef.current = isPinchingNow;

    // Clear drag highlights when idle (not pinching, not committed to drag/resize)
    if (!isPinchingNow && !dragTargetRef.current && !resizeTargetRef.current) {
      clearDragState();
    }
  };

  useEffect(() => {
    if (!generalSettings.widgetHoverHighlight || !handTrackingEnabled) {
      setHoveredAppId(null);
    }
  }, [generalSettings.widgetHoverHighlight, handTrackingEnabled]);

  // Component mapping
  const componentMap = {
    DateTimeApp,
    WeatherApp,
    NewsApp,
    SpotifyApp,
    GmailApp,
    WardrobeWidget
  };

  const renderApp = (app) => {
    const AppComponent = componentMap[app.componentPath];

    if (!AppComponent) {
      console.error(`Component not found: ${app.componentPath}`);
      return null;
    }

    const isBeingDragged = isDragging && dragTarget?.appId === app.id;
    const isBeingResized = isResizing && resizeTarget?.appId === app.id;
    const externalPosition = appPositions[app.id];
    const externalSize = appSizes[app.id];

    return (
      <DraggableApp
        key={app.id}
        appId={app.id}
        initialPosition={app.defaultPosition}
        initialSize={app.defaultSize}
        externalPosition={externalPosition}
        isExternallyDragged={isBeingDragged}
        externalSize={externalSize}
        isExternallyResized={isBeingResized}
        hoverHighlightEnabled={generalSettings.widgetHoverHighlight}
        isHoverHighlighted={generalSettings.widgetHoverHighlight && hoveredAppId === app.id}
        widgetShadowsEnabled={generalSettings.widgetShadows}
        isActive={activeWidgetId === app.id}
        onActivate={() => setActiveWidgetId(app.id)}
        gestureEnabled={generalSettings.gestureEnabled}
      >
        <AppComponent appId={app.id} />
      </DraggableApp>
    );
  };

  const wakeCircleComputed = useMemo(() => {
    if (!wakeCircle) {
      return null;
    }

    const strength = Math.max(0, Math.min(wakeCircle.strength ?? 0, 1));
    const size = 140 + strength * 80;
    const glowOpacity = 0.35 + strength * 0.45;
    const ringDuration = Math.max(0.85, 1.5 - strength * 0.6);

    return {
      strength,
      size,
      glowOpacity,
      ringDuration
    };
  }, [wakeCircle]);

  return (
    <div ref={containerRef} className="w-screen h-screen bg-black overflow-hidden relative" onClick={() => setActiveWidgetId(null)}>

      <div
        className="absolute inset-0 z-[1100] bg-black transition-opacity duration-500"
        style={{
          opacity: sleepState === 'sleeping' ? 1 : 0,
          pointerEvents: sleepState === 'awake' ? 'none' : 'auto'
        }}
      />
      {wakeCircle && wakeCircleComputed && (
        <div
          className="wake-circle-wrapper z-[1200]"
          style={{
            left: `${wakeCircle.x}px`,
            top: `${wakeCircle.y}px`,
            width: `${wakeCircleComputed.size}px`,
            height: `${wakeCircleComputed.size}px`,
            opacity: sleepState === 'awake' ? 0 : 1
          }}
        >
          <div
            className="wake-circle-core"
            style={{
              boxShadow: `0 0 ${70 + wakeCircleComputed.strength * 90}px rgba(59, 130, 246, ${wakeCircleComputed.glowOpacity})`
            }}
          />
          <div
            className="wake-circle-ring"
            style={{
              animationDuration: `${wakeCircleComputed.ringDuration}s`
            }}
          />
          <div
            className="wake-circle-ring wake-circle-ring--delayed"
            style={{
              animationDuration: `${wakeCircleComputed.ringDuration + 0.25}s`
            }}
          />
        </div>
      )}
      {/* AI Assistant overlay — handles its own visibility */}
      <AIAssistantOverlay assistant={assistant} />

      {/* Hidden audio element for WebRTC playback */}
      <audio ref={assistant.remoteAudioRef} autoPlay playsInline className="hidden" />

      {/* Audio unlock banner */}
      {!assistant.audioUnlocked && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-1.5 rounded-full text-[10px] uppercase tracking-[0.22em] text-white/25 select-none pointer-events-none" style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(0,0,0,0.6)' }}>
          Tap anywhere to enable voice
        </div>
      )}

      {/* Open AI button — also starts VAD wake word listening on first click */}
      <button
        onClick={() => {
          assistant.unlockAudio();
          // Ensure VAD is running so wake word works after this gesture grants mic
          assistant.startVAD();
          if (assistant.isOpen) {
            assistant.endSession();
          } else {
            assistant.openWithVoice();
          }
        }}
        className="fixed bottom-6 left-6 z-[1000] rounded-full px-5 py-2 text-[10px] uppercase tracking-[0.2em] text-white/30 hover:text-white/60"
        style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.7)' }}
      >
        {assistant.isOpen ? 'Close AI' : 'Open AI'}
      </button>

      {/* Active user badge — appears when phone app sets a user */}
      {activeUser && (
        <div className="fixed top-6 right-6 z-[1000] flex items-center gap-2.5 px-3 py-2 rounded-full" style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,0,0,0.7)' }}>
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold text-black"
            style={{ backgroundColor: 'var(--mirror-accent-color)' }}
          >
            {activeUser.name?.[0]?.toUpperCase() ?? '?'}
          </div>
          <span className="text-white/55 text-xs tracking-wide pr-0.5">{activeUser.name}</span>
        </div>
      )}

      {/* Face recognition badge — only show when face recognition is enabled */}
      {handTrackingEnabled && generalSettings.faceRecognitionEnabled && faceStatus !== 'idle' && (
        <div
          className="fixed top-6 z-[1000] flex items-center gap-2 px-3 py-2 rounded-full border"
          style={{
            right: activeUser ? '13rem' : '1.5rem',
            borderColor: faceStatus === 'recognized'
              ? 'rgba(74,222,128,0.35)'
              : faceStatus === 'unknown'
              ? 'rgba(250,204,21,0.35)'
              : 'rgba(255,255,255,0.10)',
            backgroundColor: faceStatus === 'recognized'
              ? 'rgba(0,0,0,0.5)'
              : faceStatus === 'unknown'
              ? 'rgba(0,0,0,0.5)'
              : 'rgba(0,0,0,0.4)'
          }}
        >
          {/* Status dot */}
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{
              backgroundColor: faceStatus === 'recognized'
                ? '#4ade80'
                : faceStatus === 'unknown'
                ? '#facc15'
                : '#6b7280',
              boxShadow: faceStatus === 'scanning'
                ? '0 0 0 2px rgba(107,114,128,0.4)'
                : faceStatus === 'recognized'
                ? '0 0 6px #4ade80'
                : '0 0 6px #facc15',
              animation: faceStatus === 'scanning' ? 'pulse 1.5s ease-in-out infinite' : 'none'
            }}
          />
          {/* Face icon */}
          <svg
            className="w-4 h-4 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            style={{
              color: faceStatus === 'recognized'
                ? '#4ade80'
                : faceStatus === 'unknown'
                ? '#facc15'
                : 'rgba(255,255,255,0.4)'
            }}
          >
            <circle cx="12" cy="8" r="4" strokeWidth="1.5" />
            <path strokeWidth="1.5" strokeLinecap="round" d="M9 21c0-3 1.5-5 3-5s3 2 3 5" />
            <circle cx="9.5" cy="7.5" r="0.5" fill="currentColor" stroke="none" />
            <circle cx="14.5" cy="7.5" r="0.5" fill="currentColor" stroke="none" />
            <path strokeWidth="1.5" strokeLinecap="round" d="M9.5 10.5c.7.7 1.3 1 2.5 1s1.8-.3 2.5-1" />
          </svg>
          {/* Label */}
          <span
            className="text-sm font-medium pr-1"
            style={{
              color: faceStatus === 'recognized'
                ? '#4ade80'
                : faceStatus === 'unknown'
                ? '#facc15'
                : 'rgba(255,255,255,0.45)'
            }}
          >
            {faceStatus === 'scanning' && 'Scanning…'}
            {faceStatus === 'recognized' && (lockedFaceUser?.name ?? 'Recognized')}
            {faceStatus === 'unknown' && 'Unknown Face'}
          </span>
        </div>
      )}

      {/* Settings Button */}
      <Link
        to="/settings"
        className="fixed bottom-6 right-6 z-[1000] rounded-full p-5 hover:opacity-80"
        style={{
          border: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(0,0,0,0.7)',
          color: 'var(--mirror-accent-color)',
          boxShadow: generalSettings.widgetShadows ? '0 12px 30px var(--mirror-accent-soft)' : 'none'
        }}
      >
        <svg className="w-9 h-9" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </Link>

      {/* Background Hand Tracking + Face Recognition Service */}
      <HandTrackingService
        onHandPosition={handleHandPosition}
        onFaceDetected={handTrackingEnabled && generalSettings.faceRecognitionEnabled ? handleFaceDetected : undefined}
        settings={getAppSettings('handtracking')}
        enabled={handTrackingEnabled}
      />

      {/* Render enabled apps */}
      {enabledApps.map(renderApp)}

      {/* Hand tracking cursor overlay */}
      <CursorOverlay
        positionRef={cursorPositionRef}
        isVisible={
          handTrackingEnabled &&
          isHandDetected &&
          (sleepState === 'awake' || (sleepState === 'sleeping' && sleepWakeCursorVisible))
        }
        isDragging={isDragging}
        variant={sleepState === 'sleeping' ? 'sleep' : 'default'}
      />

      {/* Instructions overlay (only show if no apps are enabled) */}
      {enabledApps.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className="mb-1 text-[10px] uppercase tracking-[0.3em] text-white/20">Smart Mirror</p>
            <p className="mb-8 text-sm text-white/18">No apps enabled</p>
            <Link
              to="/settings"
              className="text-[10px] uppercase tracking-[0.22em] text-white/25 rounded-full px-6 py-2.5 transition-all duration-200 hover:text-white/50"
              style={{ border: '1px solid rgba(255,255,255,0.08)' }}
            >
              Open Settings
            </Link>
          </div>
        </div>
      )}
    </div>
  );
};

export default SmartMirror;
