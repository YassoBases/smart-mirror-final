import { useEffect, useState } from 'react';

export default function WelcomeScreen({ onDone }) {
  const [fadingOut, setFadingOut] = useState(false);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setFadingOut(true), 2500);
    const doneTimer = setTimeout(() => onDone?.(), 3200);
    return () => { clearTimeout(fadeTimer); clearTimeout(doneTimer); };
  }, [onDone]);

  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-black"
      style={{
        opacity: fadingOut ? 0 : 1,
        transition: 'opacity 0.9s cubic-bezier(0.4, 0, 0.2, 1)',
        pointerEvents: 'none',
      }}
    >
      <div className="flex flex-col items-center gap-4">
        <p
          className="text-white uppercase text-sm font-light"
          style={{ animation: 'welcomeSubtitle 1s cubic-bezier(0.22, 1, 0.36, 1) 0.1s both' }}
        >
          Welcome To
        </p>
        <h1
          className="text-7xl font-bold tracking-tight"
          style={{
            color: 'var(--mirror-accent-color, #ffffff)',
            animation:
              'welcomeFadeUp 0.9s cubic-bezier(0.22, 1, 0.36, 1) 0.3s both, welcomeGlow 1.8s ease-out 0.9s both',
          }}
        >
          SmartMirror
        </h1>
        <div
          className="h-px w-0 mt-1"
          style={{
            backgroundColor: 'var(--mirror-accent-color, #ffffff)',
            opacity: 0.45,
            animation: 'welcomeBar 1s cubic-bezier(0.22, 1, 0.36, 1) 0.7s forwards',
          }}
        />
      </div>
    </div>
  );
}
