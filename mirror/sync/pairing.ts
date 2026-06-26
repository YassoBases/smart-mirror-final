import { EventEmitter } from 'events';
import type { Connection } from './connection';
import type { Identity, QRPayload } from './types';
import { writeIdentity } from './identity';
import { generateKeyPair, deriveSharedSecret, randomBytes, generatePairingCode } from './crypto';
import { getLocalIp } from './ip';

const REFRESH_INTERVAL_MS      = 290_000; // refresh 10 s before the 5-min session window
const RESOLVE_POLL_INTERVAL_MS = 5_000;   // how often to retry resolving the LAN api URL
const RESOLVE_POLL_TIMEOUT_MS  = 60_000;  // stop polling after 60 s

/**
 * Drives the one-time pairing handshake.
 *
 * Events:
 *   qr           ({ raw: string; dataUrl: string })  — show/refresh QR
 *   qr_expiring  ()                                  — session about to expire, grey out QR
 *   linked       (identity: Identity)                — pairing complete
 */
export class PairingSession extends EventEmitter {
  private keypair: { publicKey: string; privateKey: string } | null = null;
  private sid: string | null = null;
  private shortCode: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private resolvePoller: ReturnType<typeof setInterval> | null = null;
  private _stopped = false;

  // LAN HTTP API URL advertised in the QR. Resolved once via the backend's
  // netinfo endpoint and cached for the life of the session.
  private apiBaseUrl: string | null = null;

  // Bound references so we can remove them cleanly
  private readonly _onConnected = () => this._sendHello();
  private readonly _onMessage   = (msg: Record<string, unknown>) => this._handleMessage(msg);

  constructor(
    private readonly conn: Connection,
    private readonly backendUrl: string,
    private readonly identityPath: string,
    private readonly httpApiUrl: string = 'http://localhost:3000',
  ) {
    super();
  }

  // Asks the backend for its LAN-reachable API base URL. The browser/mirror
  // can't read the host's LAN IP, but the backend can. Cached after the first
  // success; on failure retries up to 3 times so a transient startup race
  // doesn't permanently omit `api` from the QR.
  private async _resolveApiBaseUrl(): Promise<string | null> {
    if (this.apiBaseUrl) return this.apiBaseUrl;
    const base = this.httpApiUrl.replace(/\/$/, '');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise<void>(r => setTimeout(r, 1000 * attempt));
        if (this.apiBaseUrl) return this.apiBaseUrl; // resolved by a concurrent call
        const res = await fetch(`${base}/api/mirror/netinfo`);
        if (!res.ok) continue;
        const info = (await res.json()) as { apiBaseUrl?: string };
        if (info.apiBaseUrl) {
          this.apiBaseUrl = info.apiBaseUrl;
          return this.apiBaseUrl;
        }
      } catch {
        // retry
      }
    }
    return null; // non-fatal — background poller will re-emit when it resolves
  }

  async start(existingKeypair?: { publicKey: string; privateKey: string }): Promise<void> {
    this.keypair   = existingKeypair ?? await generateKeyPair();
    this.shortCode = await generatePairingCode();

    // Resolve eagerly so apiBaseUrl is likely cached before the first pairing_session.
    void this._resolveApiBaseUrl();

    // Persist private key immediately so a mid-pairing crash doesn't lose it
    writeIdentity(this.identityPath, {
      privateKey: this.keypair.privateKey,
      publicKey:  this.keypair.publicKey,
    });

    this.conn.on('connected', this._onConnected);
    this.conn.on('message',   this._onMessage);

    if (this.conn.isConnected()) this._sendHello();
  }

  stop(): void {
    this._stopped = true;
    this._clearRefresh();
    this._clearResolvePoller();
    this.conn.off('connected', this._onConnected);
    this.conn.off('message',   this._onMessage);
  }

  private _sendHello(): void {
    if (!this.keypair || !this.shortCode || this._stopped) return;
    this.conn.send({
      type:              'hello',
      mirror_public_key: this.keypair.publicKey,
      short_code:        this.shortCode,
    });
  }

  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    if (this._stopped) return;

    if (msg.type === 'pairing_session') {
      this.sid = msg.sid as string;
      await this._emitQR();
      this._startRefreshTimer();
    } else if (msg.type === 'linked') {
      await this._handleLinked(msg as {
        device_token: string;
        account_id: string;
        phone_public_key: string;
      });
    }
  }

  private async _emitQR(): Promise<void> {
    if (!this.keypair || !this.sid || !this.shortCode) return;

    const nonce = await randomBytes(16);
    // Use netinfo result when available; fall back to synchronous LAN IP so the
    // very first QR always carries a valid `api` field (netinfo may not have
    // responded yet on startup).
    const apiBaseUrl = await this._resolveApiBaseUrl() ?? this._localApiUrl();
    const payload: QRPayload = {
      v:       1,
      backend: this.backendUrl,
      api:     apiBaseUrl,
      sid:     this.sid,
      mpk:     this.keypair.publicKey,
      nonce,
      code:    this.shortCode,
    };
    const raw = JSON.stringify(payload);

    // Generate a data-URL PNG so the React UI can render <img src={dataUrl} />
    let dataUrl = '';
    try {
      const qrcode = await import('qrcode');
      dataUrl = await qrcode.toDataURL(raw, { errorCorrectionLevel: 'M', width: 300 });
    } catch {
      // qrcode optional — caller can still encode `raw` with any library
    }

    this.emit('qr', { raw, dataUrl, shortCode: this.shortCode });

    // If api is still unresolved, poll in the background so the QR self-upgrades
    // to include `api` within seconds rather than waiting for the 290 s refresh.
    if (!apiBaseUrl) this._startResolvePoller();
  }

  private _startRefreshTimer(): void {
    this._clearRefresh();
    this.refreshTimer = setInterval(async () => {
      if (this._stopped) return;
      this.emit('qr_expiring');

      // Rotate the short code on every session refresh so it expires with the QR
      this.shortCode = await generatePairingCode();

      if (this.conn.isConnected()) {
        this.conn.send({ type: 'refresh_session', new_short_code: this.shortCode });
      }
      // Backend will reply with a new pairing_session → _handleMessage calls _emitQR
    }, REFRESH_INTERVAL_MS);
  }

  private _clearRefresh(): void {
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  private _startResolvePoller(): void {
    if (this.resolvePoller) return; // idempotent — only one poller at a time
    let elapsed = 0;
    this.resolvePoller = setInterval(async () => {
      if (this._stopped) { this._clearResolvePoller(); return; }
      elapsed += RESOLVE_POLL_INTERVAL_MS;
      if (elapsed > RESOLVE_POLL_TIMEOUT_MS) { this._clearResolvePoller(); return; }
      const url = await this._resolveApiBaseUrl();
      if (url) {
        this._clearResolvePoller();
        await this._emitQR();
      }
    }, RESOLVE_POLL_INTERVAL_MS);
  }

  private _clearResolvePoller(): void {
    if (this.resolvePoller) { clearInterval(this.resolvePoller); this.resolvePoller = null; }
  }

  // Synchronous fallback: builds the api URL from the local LAN IP so the
  // first QR emit always has a valid `api` field even before netinfo resolves.
  private _localApiUrl(): string {
    try {
      const port = new URL(this.httpApiUrl).port || '3000';
      return `http://${getLocalIp()}:${port}`;
    } catch {
      return `http://${getLocalIp()}:3000`;
    }
  }

  private async _handleLinked(msg: {
    device_token: string;
    account_id: string;
    phone_public_key: string;
  }): Promise<void> {
    if (!this.keypair) return;
    this.stop(); // detach all listeners before emitting

    // Only derive a shared secret if the phone actually sent its public key.
    // The Flutter app omits phonePublicKey, so skip rather than crash libsodium.
    const sharedSecret = msg.phone_public_key
      ? await deriveSharedSecret(this.keypair.privateKey, msg.phone_public_key)
      : '';

    const identity: Identity = {
      privateKey:     this.keypair.privateKey,
      publicKey:      this.keypair.publicKey,
      deviceToken:    msg.device_token,
      accountId:      msg.account_id,
      phonePublicKey: msg.phone_public_key,
      sharedSecret,
    };

    writeIdentity(this.identityPath, identity);
    this.emit('linked', identity);
  }
}
