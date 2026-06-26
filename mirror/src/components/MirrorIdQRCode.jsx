import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { backendApi } from '../services/backendApi';

/**
 * Renders a QR code that encodes the Mirror ID as a JSON payload
 * the phone app can recognize:
 *   v2: { type: "smart-mirror-pair", mirrorId: "<uuid>", api: "http://<lan-ip>:3000/api", v: 2 }
 *   v1 (fallback): { type: "smart-mirror-pair", mirrorId: "<uuid>", v: 1 }
 *
 * The phone scans this, parses the JSON, and:
 *   - stores `api` as its backend base URL (so it works on any network), and
 *   - calls PATCH /api/profiles/:id/mirror { mirrorId } to link the profile.
 *
 * The `api` field is additive — older apps simply ignore it and still pair.
 * If the backend's netinfo endpoint is unreachable we emit a v1 payload so
 * pairing still works (the app keeps whatever backend URL it already had).
 */
const MirrorIdQRCode = ({ mirrorId, size = 180 }) => {
  const [dataUrl, setDataUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!mirrorId) return;
    let cancelled = false;

    (async () => {
      let apiBaseUrl = null;
      try {
        const info = await backendApi.getNetInfo();
        apiBaseUrl = info?.apiBaseUrl || null;
      } catch (err) {
        // Non-fatal — fall back to a mirrorId-only (v1) QR.
        console.warn('[MirrorQR] netinfo unavailable, emitting v1 QR:', err.message);
      }
      if (cancelled) return;

      const payload = JSON.stringify({
        type: 'smart-mirror-pair',
        mirrorId,
        ...(apiBaseUrl ? { api: apiBaseUrl } : {}),
        v: apiBaseUrl ? 2 : 1,
      });

      try {
        const url = await QRCode.toDataURL(payload, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: size,
          color: { dark: '#000000', light: '#ffffff' },
        });
        if (!cancelled) setDataUrl(url);
      } catch (err) {
        if (!cancelled) setError(err.message || 'QR generation failed');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mirrorId, size]);

  if (error) {
    return (
      <div
        className="flex items-center justify-center rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-xs p-3"
        style={{ width: size, height: size }}
      >
        {error}
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div
        className="flex items-center justify-center rounded-lg bg-gray-700/40 border border-gray-600 text-gray-500 text-xs"
        style={{ width: size, height: size }}
      >
        Generating…
      </div>
    );
  }

  return (
    <div
      className="rounded-lg bg-white p-2 shadow-md"
      style={{ width: size + 16, height: size + 16 }}
    >
      <img
        src={dataUrl}
        alt="Mirror ID QR code"
        width={size}
        height={size}
        className="block"
        draggable={false}
      />
    </div>
  );
};

export default MirrorIdQRCode;
