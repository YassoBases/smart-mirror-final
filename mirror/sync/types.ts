export interface Identity {
  privateKey: string;       // base64 X25519 private key
  publicKey: string;        // base64 X25519 public key
  deviceToken?: string;
  accountId?: string;
  phonePublicKey?: string;  // base64 phone X25519 public key
  sharedSecret?: string;    // base64 ECDH shared secret
}

export type MirrorState = {
  modules: {
    clock?: { enabled: boolean; format: string };
    weather?: { enabled: boolean; location: string; units: 'metric' | 'imperial' };
    calendar?: { enabled: boolean; accounts: string[] };
    photos?: { enabled: boolean; album_id: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export interface StateCache {
  version: number;
  state: MirrorState;
}

export type SyncPhase =
  | 'booting'
  | 'pairing'
  | 'connecting'
  | 'syncing'
  | 'ready'
  | 'offline';

export interface QRPayload {
  v: 1;
  backend: string;        // WebSocket sync URL (mirror ↔ backend)
  api?: string;           // LAN HTTP API base, e.g. http://192.168.1.6:3000/api
                          // — lets the phone self-configure before login
  sid: string;
  mpk: string;   // mirror public key (base64)
  nonce: string; // random 16-byte (base64) prevents replay
  code: string;  // short human-readable pairing code, e.g. "A7K92Q"
}

// Messages the mirror sends to the backend
export type ClientMessage =
  | { type: 'hello'; mirror_public_key: string; short_code: string }
  | { type: 'refresh_session'; new_short_code: string }
  | { type: 'auth'; device_token: string }
  | { type: 'resync'; last_version: number }
  | { type: 'ping' };

// Messages the backend sends to the mirror
export type BackendMessage =
  | { type: 'pairing_session'; sid: string; expires_in: number }
  | { type: 'linked'; device_token: string; account_id: string; phone_public_key: string }
  | { type: 'auth_ok' }
  | { type: 'snapshot'; version: number; state: MirrorState }
  | { type: 'delta'; version: number; changes: Partial<MirrorState> }
  | { type: 'pong' }
  | { type: 'unlinked' };

// Payload broadcast over the local bridge WebSocket to the React UI
export type BridgeMessage =
  | { type: 'phase'; phase: SyncPhase }
  | { type: 'state'; state: MirrorState | null; version: number | null; phase: SyncPhase }
  | { type: 'qr'; raw: string; dataUrl: string }
  | { type: 'qr_expiring' };
