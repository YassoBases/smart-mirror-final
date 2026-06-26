import React, { useRef, useEffect } from 'react';

const CursorOverlay = React.memo(({ positionRef, isVisible, isDragging, variant }) => {
  const containerRef = useRef(null);
  const ringRef      = useRef(null);
  const dotRef       = useRef(null);
  const rippleRef    = useRef(null);
  const rafRef       = useRef(null);

  useEffect(() => {
    if (!isVisible) return;

    const isSleep = variant === 'sleep';

    const update = () => {
      const container = containerRef.current;
      if (!container) { rafRef.current = requestAnimationFrame(update); return; }

      const pos = positionRef.current;

      if (!pos?.detected) {
        container.style.display = 'none';
        rafRef.current = requestAnimationFrame(update);
        return;
      }

      const isPinching    = pos.isPinching    || false;
      const pinchStrength = pos.pinchStrength || 0;

      const baseSize          = isSleep ? 64 : 32;
      const pinchSizeReduction = isSleep ? 0 : 8;
      const currentSize       = baseSize - pinchSizeReduction * pinchStrength;
      const centerOffset      = currentSize / 2;

      container.style.display    = 'block';
      container.style.transform  = `translate3d(${pos.x - centerOffset}px,${pos.y - centerOffset}px,0)`;

      const ring = ringRef.current;
      if (ring) {
        const baseGlow  = isSleep ? 45 : (isPinching ? 30 : 20);
        const peakGlow  = isSleep ? 90 : (isPinching ? 60 : 40);
        const glow      = baseGlow + (peakGlow - baseGlow) * pinchStrength;
        const fillOp    = isSleep ? 0.35 : (isPinching ? 0.2 + 0.6 * pinchStrength : 0.2);
        const bw        = isSleep ? 6    : (isPinching ? 3 + 2 * pinchStrength : 4);
        const bAlpha    = isSleep ? 0.95 : (isPinching ? 0.8 + 0.2 * pinchStrength : 0.8);
        const glowAlpha = 0.8 + 0.2 * pinchStrength;
        const glowAlpha2 = 0.4 + 0.3 * pinchStrength;

        ring.style.width           = `${currentSize}px`;
        ring.style.height          = `${currentSize}px`;
        ring.style.border          = `${bw}px solid rgba(59,130,246,${bAlpha})`;
        ring.style.backgroundColor = `rgba(59,130,246,${fillOp})`;
        ring.style.boxShadow       = `0 0 ${glow}px rgba(59,130,246,${glowAlpha}),0 0 ${glow*2}px rgba(59,130,246,${glowAlpha2})`;
        ring.style.transform       = `scale(${1 - 0.1 * pinchStrength})`;

        const animName = isSleep ? 'sleep-pulse' : (isPinching ? 'pinch-pulse' : 'idle-pulse');
        const animDur  = isSleep ? '1.2s'        : (isPinching ? '0.5s'        : '2s');
        if (ring.dataset.anim !== animName) {
          ring.style.animation = `${animName} ${animDur} infinite`;
          ring.dataset.anim    = animName;
        }
      }

      const dot = dotRef.current;
      if (dot) {
        const ds = 4 + 2 * pinchStrength;
        dot.style.width       = `${ds}px`;
        dot.style.height      = `${ds}px`;
        dot.style.boxShadow   = `0 0 ${10 + 5 * pinchStrength}px rgba(147,197,253,1)`;
      }

      const ripple = rippleRef.current;
      if (ripple) {
        if (isPinching && !isSleep) {
          ripple.style.display      = 'block';
          ripple.style.width        = `${currentSize + 8}px`;
          ripple.style.height       = `${currentSize + 8}px`;
          ripple.style.borderColor  = `rgba(255,255,255,${0.3 + 0.4 * pinchStrength})`;
        } else {
          ripple.style.display = 'none';
        }
      }

      rafRef.current = requestAnimationFrame(update);
    };

    rafRef.current = requestAnimationFrame(update);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [positionRef, isVisible, variant]);

  if (!isVisible) return null;

  return (
    <div
      ref={containerRef}
      className="cursor-overlay fixed pointer-events-none"
      style={{ zIndex: 10000, display: 'none', willChange: 'transform' }}
    >
      <div className="relative">
        <div
          ref={ringRef}
          className="rounded-full"
          style={{ width: '32px', height: '32px' }}
        />
        <div
          ref={dotRef}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            width: '4px',
            height: '4px',
            backgroundColor: 'rgba(147,197,253,0.8)',
          }}
        />
        <div
          ref={rippleRef}
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
          style={{ display: 'none', animation: 'pinch-ripple 0.8s infinite' }}
        />
      </div>
    </div>
  );
});

export default CursorOverlay;
