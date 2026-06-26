import { useEffect, useState } from 'react';
import { backendApi } from '../services/backendApi';

/**
 * Shown on the HDMI display when the Pi has no LAN IP (netinfo returns 503).
 * Guides the user through BLE WiFi provisioning via the Smart Mirror phone app.
 * Unmounted by App.jsx once the Pi comes online.
 */
export default function SetupMode() {
  const [btName, setBtName] = useState('');
  const [statusMsg, setStatusMsg] = useState('');

  // Poll the BLE daemon's state for the real BT name + a provisioning status message.
  // getBleStatus reads the local state file, so it works even while the Pi is offline.
  useEffect(() => {
    let cancelled = false;
    const STATUS_MSGS = {
      scanning:   'Scanning for networks…',
      connecting: 'Connecting to WiFi…',
      connected:  'Connected',
      failed:     'Last attempt failed — try again',
    };
    const poll = async () => {
      const info = await backendApi.getBleStatus();
      if (cancelled) return;
      if (info?.btName) setBtName(info.btName);
      setStatusMsg(STATUS_MSGS[info?.state] || '');
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const steps = [
    {
      title: 'Open the Smart Mirror app',
      body: 'Launch the app on your iPhone or Android phone.',
    },
    {
      title: 'Tap "Set up mirror"',
      body: 'The app will scan for your mirror over Bluetooth and connect automatically.',
    },
    {
      title: 'Pick your WiFi and enter the password',
      body: (
        <>
          Choose your home WiFi — or your{' '}
          <span className="text-white/85 font-medium">phone's hotspot</span> — and
          enter the password. The app sends it to the mirror over Bluetooth.
        </>
      ),
    },
  ];

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black text-white select-none overflow-hidden">
      {/* Ambient glow */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 55% 35% at 50% 52%, rgba(56,189,248,0.04) 0%, transparent 70%)',
        }}
      />

      <div className="relative flex flex-col lg:flex-row items-center gap-16 max-w-3xl px-8 py-10">
        {/* ── Left: instructions ── */}
        <div className="flex-1">
          {/* Status pill */}
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.28em] text-white/25 mb-10">
            <span className="h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse flex-shrink-0" />
            {statusMsg || 'Waiting for setup'}
          </div>

          <h1
            className="text-4xl font-normal tracking-tight text-white/90 mb-3"
            style={{ fontFamily: "'Playfair Display', serif" }}
          >
            Set up over Bluetooth
          </h1>
          <p className="text-sm text-white/40 mb-8 leading-relaxed">
            Your mirror isn't connected to a network yet. Use the phone app to
            send your WiFi credentials over Bluetooth — no hotspot switching needed.
          </p>

          <ol className="space-y-6">
            {steps.map(({ title, body }, i) => (
              <li key={i} className="flex gap-4">
                <span
                  className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-black"
                  style={{ backgroundColor: 'rgba(255,255,255,0.85)' }}
                >
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-semibold text-white/85 mb-0.5">{title}</p>
                  <p className="text-xs text-white/40 leading-relaxed">{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>

        {/* ── Right: BT name panel ── */}
        <div className="flex flex-col items-center gap-4 flex-shrink-0">
          <div
            className="rounded-2xl border border-white/10 bg-white/5 flex flex-col items-center justify-center gap-3 px-8 py-8"
            style={{ minWidth: 180 }}
          >
            {/* Bluetooth icon */}
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="w-10 h-10 text-sky-400/70"
            >
              <path d="M6.5 6.5l11 11L12 23V1l5.5 5.5-11 11" />
            </svg>

            <p className="text-[10px] uppercase tracking-[0.2em] text-white/25 text-center">
              Look for this name
            </p>
            <p className="text-base font-semibold text-white/80 text-center leading-tight">
              {btName || 'Smart Mirror ····'}
            </p>
          </div>
          <p className="text-[11px] text-white/25 text-center leading-relaxed max-w-[180px]">
            This is your mirror's Bluetooth name. Select it in the app.
          </p>
        </div>
      </div>
    </div>
  );
}
