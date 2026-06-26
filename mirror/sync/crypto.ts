import sodium from 'libsodium-wrappers';

let ready = false;

async function init(): Promise<void> {
  if (!ready) {
    await sodium.ready;
    ready = true;
  }
}

function b64(buf: Uint8Array): string {
  return sodium.to_base64(buf, sodium.base64_variants.ORIGINAL);
}

function fromb64(s: string): Uint8Array {
  return sodium.from_base64(s, sodium.base64_variants.ORIGINAL);
}

export interface KeyPair {
  publicKey: string;  // base64
  privateKey: string; // base64
}

export async function generateKeyPair(): Promise<KeyPair> {
  await init();
  // crypto_kx_keypair produces X25519 keys compatible with crypto_scalarmult
  const kp = sodium.crypto_kx_keypair();
  return { publicKey: b64(kp.publicKey), privateKey: b64(kp.privateKey) };
}

/**
 * Derive an X25519 shared secret.
 * The private key never leaves the device — only the result is stored.
 */
export async function deriveSharedSecret(
  myPrivateKeyB64: string,
  theirPublicKeyB64: string,
): Promise<string> {
  await init();
  const shared = sodium.crypto_scalarmult(fromb64(myPrivateKeyB64), fromb64(theirPublicKeyB64));
  return b64(shared);
}

export async function randomBytes(count: number): Promise<string> {
  await init();
  return b64(sodium.randombytes_buf(count));
}

// 32-char alphabet: uppercase letters + digits, excluding 0/O and 1/I to avoid
// visual confusion when a user reads and types the code manually.
const PAIRING_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Generate a short human-readable pairing code (default 6 chars).
 * Uses 32-char alphabet so each byte maps cleanly with no modulo bias
 * (256 is evenly divisible by 32).
 */
export async function generatePairingCode(length = 6): Promise<string> {
  await init();
  const raw = sodium.randombytes_buf(length);
  return Array.from(raw).map(b => PAIRING_CODE_CHARS[b % 32]).join('');
}
