import { useEffect, useState } from 'react';
import { backendApi } from '../services/backendApi';

/**
 * Full-screen overlay shown while the mirror is bonding with a phone over BLE.
 * The Pi's pairing agent (DisplayYesNo / numeric comparison) publishes the live
 * 6-digit passkey; the user confirms it matches the code their phone shows, then
 * taps "Pair" on the phone. Renders nothing unless a pairing is actually in
 * progress, so it can stay mounted over both SetupMode (first-boot, offline) and
 * the live mirror (in-app "Change WiFi", online).
 */
export default function PairingCodeOverlay() {
  const [code, setCode] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const s = await backendApi.getBleStatus();
      if (cancelled) return;
      setCode(s?.pairingState === 'pairing' && s?.pairingCode ? String(s.pairingCode) : null);
    };
    poll();
    const id = setInterval(poll, 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!code) return null;

  const digits = code.padStart(6, '0').slice(0, 6).split('');

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/95 text-white select-none overflow-hidden">
      {/* Ambient glow — matches SetupMode */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 55% 35% at 50% 50%, rgba(56,189,248,0.06) 0%, transparent 70%)',
        }}
      />

      <div className="relative flex flex-col items-center px-8">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.28em] text-sky-300/60 mb-8">
          <span className="h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse" />
          Pairing
        </div>

        <h1
          className="text-3xl font-normal tracking-tight text-white/90 mb-3 text-center"
          style={{ fontFamily: "'Playfair Display', serif" }}
        >
          Confirm this code on your phone
        </h1>
        <p className="text-sm text-white/40 mb-10 text-center max-w-md leading-relaxed">
          Your phone is asking to pair. Check that it shows the same code below, then
          tap <span className="text-white/85 font-medium">Pair</span> on your phone.
        </p>

        <div className="flex gap-3">
          {digits.map((d, i) => (
            <div
              key={i}
              className="w-14 h-20 rounded-2xl border border-white/10 bg-white/5 flex items-center justify-center"
            >
              <span className="text-4xl font-semibold text-white/90 tabular-nums">{d}</span>
            </div>
          ))}
        </div>

        <p className="text-[11px] text-white/25 text-center mt-10 max-w-xs leading-relaxed">
          If the codes don't match, another device may be trying to connect — cancel on your phone.
        </p>
      </div>
    </div>
  );
}
