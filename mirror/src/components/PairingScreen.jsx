import { useEffect, useState } from 'react';
import { useMirrorSync } from '../hooks/useMirrorSync';
import { useGuestMode } from '../contexts/GuestModeContext';
import GestureControl from './GestureControl';

// This screen renders before the mirror, so SmartMirror's hand tracking is not
// mounted yet. GestureControl provides its own cursor + pinch-to-click here
// (face-recognition model off) so the QR/code screen is fully gesture-operable.

// ─── Main pairing / login screen ─────────────────────────────────────────────

export default function PairingScreen({ onComplete, autoAdvance = true }) {
  const { phase, qrData, shortCode, qrExpiring, bridgeOnline, mirrorIp, factoryReset } = useMirrorSync();
  const { enterGuest } = useGuestMode();
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  // Advance when phone connects via QR — only during the initial intro flow
  useEffect(() => {
    if (autoAdvance && phase === 'ready') onComplete?.();
  }, [autoAdvance, phase, onComplete]);

  // Advance after a short delay if the sync bridge is unreachable
  // (skip when accessed as a dedicated /pairing route — user stays until they leave manually)
  useEffect(() => {
    if (!autoAdvance || phase !== 'bridge_unavailable') return;
    const t = setTimeout(() => onComplete?.(), 1500);
    return () => clearTimeout(t);
  }, [autoAdvance, phase, onComplete]);

  const handleEnterGuest = () => {
    enterGuest();
    onComplete?.();
  };

  const visible = !autoAdvance || phase === 'booting' || phase === 'pairing' || phase === 'bridge_unavailable';
  if (!visible) return null;

  // When accessed as a route and the mirror is already linked, show a status screen
  // instead of the QR flow so the user can see current state / re-pair / go back.
  if (!autoAdvance && phase === 'ready') {
    return (
      <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black text-white select-none">
        <GestureControl />

        {!confirmUnlink ? (
          <>
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
              style={{ border: '1px solid rgba(52,211,153,0.3)', background: 'rgba(52,211,153,0.07)' }}>
              <svg className="w-7 h-7 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h1 className="text-2xl font-normal text-white/85 mb-2" style={{ fontFamily: "'Playfair Display', serif" }}>
              Mirror is linked
            </h1>
            <p className="text-xs text-white/35 mb-10 tracking-wide">
              A phone account is connected to this mirror.
            </p>
            <div className="flex flex-col items-center gap-3 w-64">
              <button
                onClick={() => onComplete?.()}
                className="w-full rounded-full py-3 text-sm text-white/70 transition-all hover:text-white/90 active:scale-95"
                style={{ border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.05)' }}
              >
                ← Back to mirror
              </button>
              <button
                onClick={() => setConfirmUnlink(true)}
                className="w-full rounded-full py-3 text-sm text-red-400/60 transition-all hover:text-red-400/90 active:scale-95"
                style={{ border: '1px solid rgba(239,68,68,0.18)' }}
              >
                Unlink &amp; re-pair
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full"
              style={{ border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.07)' }}>
              <svg className="w-7 h-7 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
            </div>
            <h1 className="text-2xl font-normal text-white/85 mb-2" style={{ fontFamily: "'Playfair Display', serif" }}>
              Unlink mirror?
            </h1>
            <p className="text-xs text-white/35 mb-10 tracking-wide text-center max-w-xs">
              This will remove the phone link. You'll need to scan the QR code again to reconnect.
            </p>
            <div className="flex flex-col items-center gap-3 w-64">
              <button
                onClick={() => factoryReset()}
                className="w-full rounded-full py-3 text-sm text-red-400/80 transition-all hover:text-red-300 active:scale-95"
                style={{ border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(239,68,68,0.06)' }}
              >
                Yes, unlink &amp; re-pair
              </button>
              <button
                onClick={() => setConfirmUnlink(false)}
                className="w-full rounded-full py-3 text-sm text-white/45 transition-all hover:text-white/75 active:scale-95"
                style={{ border: '1px solid rgba(255,255,255,0.1)' }}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  const hasQR     = Boolean(qrData?.dataUrl);
  const isBooting = phase === 'booting';

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black text-white select-none overflow-hidden">

      {/* Hand-gesture cursor + pinch-to-click for the pairing screen (no face model). */}
      <GestureControl />

      {/* Ambient glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse 55% 35% at 50% 52%, rgba(56,189,248,0.045) 0%, transparent 70%)'
        }}
      />

      {/* Status pill */}
      <div className="relative mb-12 flex items-center gap-2 text-[10px] uppercase tracking-[0.28em] text-white/25">
        <span className={`h-1 w-1 rounded-full ${bridgeOnline ? 'bg-emerald-500' : 'bg-amber-400 animate-pulse'}`} />
        {bridgeOnline ? 'Sync connected' : 'Connecting…'}
      </div>

      {/* Headline */}
      <h1
        className="relative mb-2 text-5xl font-normal tracking-tight text-white/90"
        style={{ fontFamily: "'Playfair Display', serif" }}
      >
        Welcome
      </h1>
      <p className="relative mb-12 text-[11px] uppercase tracking-[0.3em] text-white/25">
        Sign in or explore as a guest
      </p>

      {/* ── Two-column card ───────────────────────────────────────────────── */}
      <div
        className="relative flex items-stretch overflow-hidden"
        style={{
          border: '1px solid rgba(255,255,255,0.07)',
          borderRadius: '20px',
          background: 'rgba(15,15,15,0.95)',
        }}
      >
        {/* Left — QR sign-in */}
        <div className="flex w-64 flex-col items-center justify-between px-8 py-8">
          <p className="mb-6 text-[9px] uppercase tracking-[0.28em] text-white/22">
            Phone sign-in
          </p>

          <div className="relative flex flex-1 items-center justify-center">
            {hasQR ? (
              <div
                className="overflow-hidden rounded-xl"
                style={{
                  border: '1px solid rgba(255,255,255,0.07)',
                  opacity: qrExpiring ? 0.15 : 1,
                  transition: 'opacity 0.5s',
                }}
              >
                <img
                  src={qrData.dataUrl}
                  alt="Pairing QR code"
                  width={176}
                  height={176}
                />
              </div>
            ) : (
              <div
                className="flex h-44 w-44 flex-col items-center justify-center gap-3 rounded-xl"
                style={{ border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.015)' }}
              >
                <Spinner />
                <span className="text-[10px] tracking-wider text-white/20">
                  {isBooting ? 'Starting…' : 'Waiting…'}
                </span>
              </div>
            )}

            {qrExpiring && hasQR && (
              <div className="absolute inset-0 flex items-center justify-center rounded-xl">
                <span className="rounded-full bg-black/90 px-3 py-1 text-[10px] tracking-[0.2em] text-amber-400/70 uppercase">
                  Refreshing
                </span>
              </div>
            )}
          </div>

          {shortCode && !qrExpiring ? (
            <div className="mt-6 text-center">
              <p className="mb-2 text-[9px] uppercase tracking-[0.28em] text-white/20">
                Or enter code
              </p>
              <p className="font-mono text-2xl font-light tracking-[0.35em] text-white/80">
                {shortCode}
              </p>
            </div>
          ) : (
            <p className="mt-6 text-center text-[10px] leading-relaxed tracking-wide text-white/18">
              Open the mirror app<br />and scan to pair
            </p>
          )}

          {/* Mirror IP — shown so users can verify both devices are on the same network */}
          {mirrorIp && mirrorIp !== '127.0.0.1' && (
            <div className="mt-4 text-center">
              <p className="text-[8px] uppercase tracking-[0.2em] text-white/15">Mirror IP</p>
              <p className="font-mono text-[11px] text-white/35 mt-0.5">{mirrorIp}</p>
            </div>
          )}
          {mirrorIp === '127.0.0.1' && (
            <p className="mt-4 text-center text-[9px] text-amber-400/50 leading-relaxed">
              No Wi-Fi detected — phone<br />cannot connect via QR
            </p>
          )}
        </div>

        {/* Center divider */}
        <div className="flex flex-col items-center justify-center py-8 px-0">
          <div className="w-px flex-1" style={{ background: 'rgba(255,255,255,0.05)' }} />
          <span className="my-4 text-[9px] uppercase tracking-[0.22em] text-white/15">or</span>
          <div className="w-px flex-1" style={{ background: 'rgba(255,255,255,0.05)' }} />
        </div>

        {/* Right — Guest mode */}
        <div className="flex w-64 flex-col items-center justify-between px-8 py-8">
          <p className="mb-6 text-[9px] uppercase tracking-[0.28em] text-white/22">
            Guest mode
          </p>

          <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
            <div
              className="flex h-14 w-14 items-center justify-center rounded-full"
              style={{ border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.03)' }}
            >
              <svg className="w-6 h-6 text-white/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </div>

            <div>
              <p className="text-sm font-medium text-white/75">Guest Mode</p>
              <p className="mt-1 text-[11px] leading-relaxed text-white/28">
                All widgets, no account
              </p>
            </div>

            {/* Gesture-clickable — SmartMirror's pinch handler fires el.click()
                on whatever element is under the cursor, including this button */}
            <button
              onClick={handleEnterGuest}
              className="rounded-full px-8 py-2.5 text-xs tracking-[0.14em] text-white/50 transition-all duration-200 hover:text-white/80"
              style={{ border: '1px solid rgba(255,255,255,0.10)', background: 'rgba(255,255,255,0.025)' }}
            >
              Enter Mirror
            </button>

            <p className="flex items-center gap-1.5 text-[9px] uppercase tracking-[0.2em] text-white/15">
              <span style={{ fontSize: '11px' }}>✋</span>
              Pinch to select
            </p>
          </div>

          <p className="mt-4 text-center text-[10px] tracking-wide text-white/15">
            No account needed
          </p>
        </div>
      </div>

      {/* Footer */}
      <p className="relative mt-8 text-[9px] uppercase tracking-[0.28em] text-white/15">
        Code refreshes every 5 minutes
      </p>

      <button
        onClick={factoryReset}
        className="relative mt-3 text-[9px] uppercase tracking-[0.2em] text-white/15 transition-colors hover:text-white/30"
      >
        Reset device
      </button>

      {!autoAdvance && (
        <button
          onClick={() => onComplete?.()}
          className="relative mt-4 text-[10px] uppercase tracking-[0.2em] text-white/25 transition-colors hover:text-white/55 border border-white/10 rounded-full px-5 py-1.5"
        >
          ← Back to mirror
        </button>
      )}
    </div>
  );
}

// ─── Account/guest button shown in Settings ───────────────────────────────────

export function DeviceAccountButton({ className = '' }) {
  const { phase, factoryReset } = useMirrorSync();
  const { guestMode, exitGuest } = useGuestMode();

  if (guestMode) {
    return (
      <button
        onClick={exitGuest}
        className={`rounded border border-amber-500/30 px-3 py-1 text-xs text-amber-400/70
                    hover:border-amber-400/50 hover:text-amber-300/90 transition-colors ${className}`}
      >
        Exit Guest Mode
      </button>
    );
  }

  if (phase !== 'ready' && phase !== 'offline' && phase !== 'connecting') return null;

  return (
    <button
      onClick={() => {
        if (window.confirm('Unlink this mirror and restart pairing?')) factoryReset();
      }}
      className={`rounded border border-white/[0.08] px-3 py-1 text-xs text-white/35
                  hover:border-white/20 hover:text-white/60 transition-colors ${className}`}
    >
      Unlink device
    </button>
  );
}

function Spinner() {
  return (
    <svg className="h-7 w-7 animate-spin text-white/15" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
