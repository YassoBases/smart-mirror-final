import { useState, useEffect, useRef, useCallback } from 'react';

const BRIDGE_PORT = process.env.REACT_APP_BRIDGE_PORT ?? '4002';
const BASE = `http://localhost:${BRIDGE_PORT}`;

const POLL_INTERVAL_MS   = 1_000;
const RETRY_INTERVAL_MS  = 2_000;
const BOOT_TIMEOUT_MS    = 5_000;

/**
 * Polls the local mirror-sync HTTP bridge (GET /status, GET /qr).
 *
 * Returns:
 *   state        — current MirrorState or null
 *   phase        — sync phase string
 *   qrData       — { raw, dataUrl } during pairing, null otherwise
 *   qrExpiring   — true when QR session is about to refresh
 *   bridgeOnline — true once the bridge has responded at least once
 *   isOffline    — true when upstream connection is lost
 *   factoryReset — call to wipe identity + restart pairing
 */
export function useMirrorSync() {
  const [state,        setState]       = useState(null);
  const [phase,        setPhase]       = useState('booting');
  const [qrData,       setQrData]      = useState(null);
  const [shortCode,    setShortCode]   = useState(null);
  const [qrExpiring,   setQrExpiring]  = useState(false);
  const [bridgeOnline, setBridgeOnline]= useState(false);
  const [mirrorIp,     setMirrorIp]    = useState(null);

  const pollTimer  = useRef(null);
  const bootTimer  = useRef(null);
  const unmounted  = useRef(false);
  const online     = useRef(false);   // shadow ref to avoid stale closure in boot timer

  const poll = useCallback(async () => {
    if (unmounted.current) return;

    try {
      const res = await fetch(`${BASE}/status`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (!online.current) {
        online.current = true;
        setBridgeOnline(true);
        clearTimeout(bootTimer.current);
      }

      setPhase(data.phase);
      setState(data.state ?? null);

      // Keep localStorage in sync — backendApi.getMirrorId() reads 'smartMirrorId',
      // but the DB uses the mirror's public key as mirror_id (set during QR pairing).
      if (data.mirrorPublicKey) {
        localStorage.setItem('smartMirrorId', data.mirrorPublicKey);
      }

      // Fetch QR only when pairing — avoids a 404 log on every poll
      if (data.phase === 'pairing') {
        const qRes = await fetch(`${BASE}/qr`, { cache: 'no-store' });
        if (qRes.ok) {
          const q = await qRes.json();
          setQrData({ raw: q.raw, dataUrl: q.dataUrl });
          setShortCode(q.shortCode ?? null);
          setQrExpiring(Boolean(q.expiring));
        }
      } else {
        setQrData(null);
        setShortCode(null);
        setQrExpiring(false);
      }

      pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
    } catch {
      // Bridge unreachable — retry slower
      pollTimer.current = setTimeout(poll, RETRY_INTERVAL_MS);
    }
  }, []);

  useEffect(() => {
    // Give the bridge BOOT_TIMEOUT_MS to respond before showing the mirror
    bootTimer.current = setTimeout(() => {
      if (!unmounted.current && !online.current) {
        setPhase('bridge_unavailable');
      }
    }, BOOT_TIMEOUT_MS);

    // Fetch mirror LAN IP once for display on the pairing screen
    fetch(`${BASE}/ip`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.ip && !unmounted.current) setMirrorIp(d.ip); })
      .catch(() => {});

    poll();

    return () => {
      unmounted.current = true;
      clearTimeout(pollTimer.current);
      clearTimeout(bootTimer.current);
    };
  }, [poll]);

  const factoryReset = useCallback(async () => {
    try {
      await fetch(`${BASE}/factory-reset`, { method: 'POST', cache: 'no-store' });
    } catch { /* ignore */ }
  }, []);

  return {
    state,
    phase,
    qrData,
    shortCode,
    qrExpiring,
    bridgeOnline,
    mirrorIp,
    isOffline: phase === 'offline',
    factoryReset,
  };
}
