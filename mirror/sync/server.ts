/**
 * Standalone entry point — run alongside the React dev server:
 *
 *   npm run sync:dev          (ts-node, development)
 *   npm run sync:start        (compiled JS, production)
 *
 * On a Raspberry Pi you'd typically start this as a systemd service and let the
 * React build be served by a static file server on a different port.
 */

import { start, onStateChange, getPhase } from './index';
import { startBridge } from './bridge';

async function main(): Promise<void> {
  console.log('[mirror-sync] starting …');

  // Start the local WebSocket bridge for the React UI
  startBridge();

  // Subscribe for console logging (useful during development)
  onStateChange((state, phase) => {
    console.log(`[mirror-sync] phase=${phase}`, state ? `version=${JSON.stringify(state).slice(0, 60)}` : '(no state)');
  });

  // Boot the sync module — handles pairing or direct connect depending on
  // whether a valid identity file exists
  await start();
}

main().catch((err) => {
  console.error('[mirror-sync] fatal:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT',  () => { console.log('[mirror-sync] shutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[mirror-sync] shutting down'); process.exit(0); });
