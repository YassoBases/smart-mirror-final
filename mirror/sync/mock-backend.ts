/**
 * Development mock backend — simulates the remote WebSocket server.
 *
 *   npm run mock-backend
 *
 * Interactive commands (type in this terminal):
 *   link    → send { type: "linked" } so the mirror transitions to sync mode
 *   unlink  → send { type: "unlinked" } so the mirror factory-resets
 *   delta   → push a small state change (clock format)
 *   snap    → push a fresh snapshot (version 5)
 */

import { WebSocketServer, WebSocket } from 'ws';
import sodium from 'libsodium-wrappers';
import * as readline from 'readline';

const PORT = 4000;

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function b64(buf: Uint8Array): string {
  return sodium.to_base64(buf, sodium.base64_variants.ORIGINAL);
}

const SNAPSHOT_V1 = {
  modules: {
    clock:    { enabled: true,  format: 'HH:mm' },
    weather:  { enabled: true,  location: 'London', units: 'metric' },
    calendar: { enabled: false, accounts: [] },
    photos:   { enabled: false, album_id: '' },
  },
};

async function main(): Promise<void> {
  await sodium.ready;

  // Generate a throw-away phone keypair for the ECDH mock
  const phoneKP = sodium.crypto_kx_keypair();
  const phonePubB64 = b64(phoneKP.publicKey);

  const wss = new WebSocketServer({ port: PORT });
  console.log(`\n[mock-backend] listening on ws://localhost:${PORT}`);
  console.log('[mock-backend] waiting for mirror to connect…\n');

  // Track the active client so readline commands can address it
  let activeWs: WebSocket | null = null;
  let version = 1;

  wss.on('connection', (ws) => {
    activeWs = ws;
    console.log('[mock-backend] mirror connected');

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      const { type } = msg;
      console.log(`[mock-backend] ← ${type}`);

      switch (type) {
        case 'hello': {
          const sid = makeId('sid');
          const shortCode = (msg.short_code as string) || '(none)';
          ws.send(JSON.stringify({ type: 'pairing_session', sid, expires_in: 300 }));
          console.log(`\n[mock-backend] QR session open  sid=${sid}  code=${shortCode}`);
          console.log('[mock-backend] type "link" to simulate phone scan\n');
          break;
        }

        case 'refresh_session': {
          const sid = makeId('sid');
          const newCode = (msg.new_short_code as string) || '(none)';
          ws.send(JSON.stringify({ type: 'pairing_session', sid, expires_in: 300 }));
          console.log(`[mock-backend] QR refreshed  new sid=${sid}  new code=${newCode}`);
          break;
        }

        case 'auth': {
          ws.send(JSON.stringify({ type: 'auth_ok' }));
          setTimeout(() => {
            version = 1;
            ws.send(JSON.stringify({ type: 'snapshot', version, state: SNAPSHOT_V1 }));
            console.log('[mock-backend] → auth_ok + snapshot v1');
          }, 100);
          break;
        }

        case 'resync': {
          const last = msg.last_version as number;
          version = Math.max(version, 1);
          ws.send(JSON.stringify({ type: 'snapshot', version, state: SNAPSHOT_V1 }));
          console.log(`[mock-backend] → snapshot v${version} (resync from ${last})`);
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
        }

        default:
          console.log(`[mock-backend] (unhandled) ${type}`);
      }
    });

    ws.on('close', () => {
      console.log('[mock-backend] mirror disconnected');
      if (activeWs === ws) activeWs = null;
    });
  });

  // Interactive CLI
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  console.log('Commands: link | unlink | delta | snap\n');

  rl.on('line', (line) => {
    const cmd = line.trim();
    if (!activeWs || activeWs.readyState !== WebSocket.OPEN) {
      console.log('[mock-backend] no active mirror connection');
      return;
    }

    if (cmd === 'link') {
      const token = makeId('dt');
      activeWs.send(JSON.stringify({
        type:           'linked',
        device_token:   token,
        account_id:     'acc-demo-001',
        phone_public_key: phonePubB64,
      }));
      console.log(`[mock-backend] → linked (token=${token})`);

    } else if (cmd === 'unlink') {
      activeWs.send(JSON.stringify({ type: 'unlinked' }));
      console.log('[mock-backend] → unlinked (mirror will factory-reset)');

    } else if (cmd === 'delta') {
      version += 1;
      activeWs.send(JSON.stringify({
        type:    'delta',
        version,
        changes: { modules: { clock: { enabled: true, format: 'hh:mm a' } } },
      }));
      console.log(`[mock-backend] → delta v${version} (clock format changed)`);

    } else if (cmd === 'snap') {
      version = 5;
      activeWs.send(JSON.stringify({ type: 'snapshot', version, state: SNAPSHOT_V1 }));
      console.log(`[mock-backend] → snapshot v${version}`);

    } else {
      console.log('Commands: link | unlink | delta | snap');
    }
  });
}

main().catch((err) => { console.error('[mock-backend] fatal:', err); process.exit(1); });
