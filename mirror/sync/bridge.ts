/**
 * Local HTTP bridge server
 *
 * Exposes a tiny REST API on localhost so the React browser UI can poll for
 * sync state without any WebSocket/CORS complexity:
 *
 *   GET  /status          → { phase, state, version }
 *   GET  /qr              → { raw, dataUrl } | 404 when not in pairing phase
 *   POST /factory-reset   → triggers wipe + re-pairing (returns 200)
 *
 * All responses include permissive CORS headers so fetch() from any localhost
 * port works without a proxy.
 */

import * as http from 'http';
import { getEmitter, getState, getPhase, factoryReset, getMirrorPublicKey } from './index';
import type { MirrorState, SyncPhase } from './types';
import { loadConfig } from './config';
import { getLocalIp } from './ip';

export function startBridge(): http.Server {
  const { bridgePort } = loadConfig();
  const emit = getEmitter();

  // In-memory cache of the latest QR so polls see it immediately
  let lastQR: { raw: string; dataUrl: string; shortCode: string } | null = null;
  let lastQRExpiring = false;

  emit.on('qr', (data: { raw: string; dataUrl: string; shortCode: string }) => {
    lastQR = data;
    lastQRExpiring = false;
  });

  emit.on('qr_expiring', () => { lastQRExpiring = true; });

  emit.on('state', (_state: MirrorState | null, phase: SyncPhase) => {
    if (phase !== 'pairing') { lastQR = null; lastQRExpiring = false; }
  });

  const server = http.createServer((req, res) => {
    // Permissive CORS — this server is local-only, security is network-level
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204); res.end(); return;
    }

    const url = req.url ?? '/';

    if (req.method === 'GET' && url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        phase:          getPhase(),
        state:          getState(),
        version:        null,
        mirrorPublicKey: getMirrorPublicKey(),
      }));
      return;
    }

    if (req.method === 'GET' && url === '/qr') {
      if (!lastQR) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no QR available' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...lastQR, expiring: lastQRExpiring }));
      return;
    }

    if (req.method === 'POST' && url === '/factory-reset') {
      void factoryReset();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && url === '/ip') {
      const cfg  = loadConfig();
      const ip   = getLocalIp();
      const port = new URL(cfg.httpApiUrl).port || '3000';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ip,
        mirrorUrl: `http://${ip}:${port}`,
        warning: ip === '127.0.0.1' ? 'Could not detect LAN IP — phone pairing will not work' : null,
      }));
      return;
    }

    // Debug-only: exposes the raw Mirror ID (public key). Never shown in normal UI.
    if (req.method === 'GET' && url === '/debug/identity' && process.env.NODE_ENV !== 'production') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mirrorPublicKey: getMirrorPublicKey() }));
      return;
    }

    res.writeHead(404); res.end();
  });

  server.listen(bridgePort, () => {
    console.log(`[mirror-bridge] http://localhost:${bridgePort} (GET /status, GET /qr, POST /factory-reset)`);
  });

  return server;
}
