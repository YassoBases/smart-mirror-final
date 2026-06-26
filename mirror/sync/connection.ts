import WebSocket from 'ws';
import { EventEmitter } from 'events';

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS  = 10_000;
const BASE_BACKOFF_MS  = 1_000;
const MAX_BACKOFF_MS   = 30_000;

/**
 * Managed WebSocket connection with:
 * - Automatic reconnect with exponential backoff (1 s → 30 s)
 * - Heartbeat ping/pong (handled internally; pong is NOT forwarded as a 'message' event)
 *
 * Events:
 *   connected    — socket open and ready
 *   disconnected — socket closed; reconnect is already scheduled
 *   message      — parsed JSON object from server (pong excluded)
 *   error        — underlying socket error (close event follows)
 */
export class Connection extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout>  | null = null;
  private pingTimer:      ReturnType<typeof setInterval> | null = null;
  private pongTimer:      ReturnType<typeof setTimeout>  | null = null;
  private backoffMs = BASE_BACKOFF_MS;
  private _connected = false;
  private _destroyed = false;

  constructor(private readonly url: string) {
    super();
  }

  connect(): void {
    if (this._destroyed) return;
    this._clearTimers();
    this._tryConnect();
  }

  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  isConnected(): boolean { return this._connected; }

  destroy(): void {
    this._destroyed = true;
    this._clearTimers();
    this.ws?.terminate();
    this.ws = null;
    this._connected = false;
  }

  private _tryConnect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = BASE_BACKOFF_MS;
      this._connected = true;
      this._startPing();
      this.emit('connected');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type === 'pong') {
          // Acknowledge heartbeat; don't forward
          if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
          return;
        }
        this.emit('message', msg);
      } catch { /* discard malformed frames */ }
    });

    ws.on('close', () => {
      this._connected = false;
      this._stopPing();
      if (!this._destroyed) {
        this.emit('disconnected');
        this._scheduleReconnect();
      }
    });

    ws.on('error', (err: Error) => this.emit('error', err));
  }

  private _scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      if (!this._destroyed) this._tryConnect();
    }, delay);
  }

  private _startPing(): void {
    this.pingTimer = setInterval(() => {
      if (!this._connected) return;
      this.send({ type: 'ping' });
      // If pong doesn't arrive within timeout, terminate and let backoff reconnect
      this.pongTimer = setTimeout(() => { this.ws?.terminate(); }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private _stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer);  this.pongTimer = null; }
  }

  private _clearTimers(): void {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._stopPing();
  }
}
