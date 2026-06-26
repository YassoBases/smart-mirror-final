/**
 * Mirror Sync Module
 *
 * Entry points:
 *   start()                          boot the module (call once)
 *   onStateChange(cb) → unsubscribe  subscribe to state/phase changes
 *   getState()                       current MirrorState or null
 *   getPhase()                       current SyncPhase
 *   factoryReset()                   wipe identity + cache, restart pairing
 *
 * The module also emits EventEmitter events ('qr', 'qr_expiring', 'state',
 * 'phase') that the local bridge server re-broadcasts to the React UI.
 */

import { EventEmitter } from 'events';
import { loadConfig, MirrorConfig } from './config';
import { readIdentity, writeIdentity, wipeIdentity, isLinked } from './identity';
import { Connection } from './connection';
import { PairingSession } from './pairing';
import {
  loadStateCache,
  saveStateCache,
  wipeStateCache,
  applyDelta,
} from './state';
import type { Identity, MirrorState, SyncPhase, StateCache } from './types';

type StateChangeCallback = (state: MirrorState | null, phase: SyncPhase) => void;
type Unsubscribe = () => void;

class MirrorSync extends EventEmitter {
  private cfg: MirrorConfig;
  private identity: Identity | null = null;
  private cache: StateCache | null = null;
  private conn: Connection | null = null;
  private pairing: PairingSession | null = null;
  private phase: SyncPhase = 'booting';
  private subscribers: StateChangeCallback[] = [];
  private started = false;

  // Named bound handlers so we can attach/detach cleanly
  private syncOnConnected = () => this._authenticate();
  private syncOnMessage   = (m: Record<string, unknown>) => this._handleSyncMessage(m);
  private syncOnDisconnect = () => {
    if (this.cache) {
      this._setPhase('offline');
    }
  };

  constructor() {
    super();
    this.cfg = loadConfig();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.cache    = loadStateCache(this.cfg.stateCachePath);
    this.identity = readIdentity(this.cfg.identityPath);

    if (isLinked(this.identity)) {
      await this._connectAndSync();
    } else {
      await this._runPairing();
    }
  }

  onStateChange(cb: StateChangeCallback): Unsubscribe {
    this.subscribers.push(cb);
    cb(this.cache?.state ?? null, this.phase); // immediate call with current value
    return () => { this.subscribers = this.subscribers.filter(s => s !== cb); };
  }

  getState(): MirrorState | null {
    return this.cache?.state ?? null;
  }

  getPhase(): SyncPhase {
    return this.phase;
  }

  getPublicKey(): string | null {
    return this.identity?.publicKey ?? null;
  }

  async factoryReset(): Promise<void> {
    this._teardownSync();
    this.pairing?.stop();
    this.pairing = null;
    this.identity = null;
    this.cache    = null;
    wipeIdentity(this.cfg.identityPath);
    wipeStateCache(this.cfg.stateCachePath);
    await this._runPairing();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private _setPhase(p: SyncPhase): void {
    this.phase = p;
    this.emit('phase', p);
    this._notifySubscribers();
  }

  private _notifySubscribers(): void {
    const state = this.cache?.state ?? null;
    for (const cb of this.subscribers) cb(state, this.phase);
    this.emit('state', state, this.phase);
  }

  private _getConn(): Connection {
    if (!this.conn) {
      this.conn = new Connection(this.cfg.backendUrl);
      this.conn.on('error', (err: Error) => {
        // Errors are followed by a 'close' event that triggers reconnect
        console.error('[mirror-sync] ws error:', err.message);
      });
      this.conn.connect();
    }
    return this.conn;
  }

  // ── Pairing phase ──────────────────────────────────────────────────────────

  private async _runPairing(): Promise<void> {
    this._setPhase('pairing');
    const conn = this._getConn();

    // Reuse an existing (partial) keypair so a mid-pairing crash doesn't
    // generate a new keypair and confuse a partially-completed handshake
    const stored = readIdentity(this.cfg.identityPath);
    const existingKP = stored
      ? { publicKey: stored.publicKey, privateKey: stored.privateKey }
      : undefined;

    const session = new PairingSession(
      conn, this.cfg.backendUrl, this.cfg.identityPath, this.cfg.httpApiUrl);
    this.pairing  = session;

    session.on('qr', (data: { raw: string; dataUrl: string }) => {
      this.emit('qr', data);
    });

    session.on('qr_expiring', () => {
      this.emit('qr_expiring');
    });

    session.on('linked', async (identity: Identity) => {
      this.pairing  = null;
      this.identity = identity;
      await this._connectAndSync();
    });

    await session.start(existingKP);
  }

  // ── Connect + sync phase ───────────────────────────────────────────────────

  private async _connectAndSync(): Promise<void> {
    if (!isLinked(this.identity)) return;
    this._teardownSync(); // remove stale listeners before adding fresh ones

    this._setPhase('connecting');
    const conn = this._getConn();

    conn.on('connected',    this.syncOnConnected);
    conn.on('message',      this.syncOnMessage);
    conn.on('disconnected', this.syncOnDisconnect);

    if (conn.isConnected()) this._authenticate();
  }

  private _teardownSync(): void {
    if (!this.conn) return;
    this.conn.off('connected',    this.syncOnConnected);
    this.conn.off('message',      this.syncOnMessage);
    this.conn.off('disconnected', this.syncOnDisconnect);
  }

  private _authenticate(): void {
    if (!isLinked(this.identity)) return;
    this._setPhase('connecting');
    this.conn!.send({ type: 'auth', device_token: this.identity.deviceToken });
  }

  private _handleSyncMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'auth_ok': {
        this._setPhase('syncing');
        // Always resync after auth so we converge even if we missed deltas while offline
        this.conn!.send({ type: 'resync', last_version: this.cache?.version ?? 0 });
        break;
      }

      case 'snapshot': {
        const { version, state } = msg as { version: number; state: MirrorState };
        this.cache = { version, state };
        saveStateCache(this.cfg.stateCachePath, this.cache);
        this._setPhase('ready');
        break;
      }

      case 'delta': {
        const { version, changes } = msg as {
          version: number;
          changes: Partial<MirrorState>;
        };

        if (!this.cache) {
          // No baseline — request a full snapshot
          this.conn!.send({ type: 'resync', last_version: 0 });
          return;
        }

        if (version !== this.cache.version + 1) {
          // Version gap — request resync so we don't apply stale deltas
          this.conn!.send({ type: 'resync', last_version: this.cache.version });
          return;
        }

        const newState = applyDelta(this.cache.state, changes);
        this.cache = { version, state: newState };
        saveStateCache(this.cfg.stateCachePath, this.cache);
        if (this.phase !== 'ready') this._setPhase('ready');
        else this._notifySubscribers();
        break;
      }

      case 'unlinked': {
        // Server revoked the device — wipe and re-pair
        void this.factoryReset();
        break;
      }
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

let _instance: MirrorSync | null = null;

function instance(): MirrorSync {
  if (!_instance) _instance = new MirrorSync();
  return _instance;
}

// ─── Public exports ──────────────────────────────────────────────────────────

/** Boot the sync module. Call once at application start. */
export async function start(): Promise<void> {
  return instance().start();
}

/** Alias matching the spec's startPairing() name. */
export const startPairing = start;

/**
 * Subscribe to state/phase changes. Returns an unsubscribe function.
 * The callback is called immediately with the current state.
 */
export function onStateChange(cb: StateChangeCallback): Unsubscribe {
  return instance().onStateChange(cb);
}

/** Returns the latest known MirrorState, or null before the first snapshot. */
export function getState(): MirrorState | null {
  return instance().getState();
}

/** Current SyncPhase. */
export function getPhase(): SyncPhase {
  return instance().getPhase();
}

/**
 * Wipe identity file and state cache, then restart pairing.
 * Equivalent to a hardware factory reset.
 */
export async function factoryReset(): Promise<void> {
  return instance().factoryReset();
}

/**
 * Expose the raw EventEmitter so callers can listen to 'qr', 'qr_expiring',
 * 'state', and 'phase' events directly (used by the bridge server).
 */
export function getEmitter(): MirrorSync {
  return instance();
}

/**
 * Returns the mirror's X25519 public key (its stable internal Mirror ID).
 * Used only by the debug bridge endpoint — never shown in the normal UI.
 */
export function getMirrorPublicKey(): string | null {
  return instance().getPublicKey();
}

export type { MirrorState, SyncPhase, StateChangeCallback, Unsubscribe };
