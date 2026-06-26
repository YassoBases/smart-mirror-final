import * as fs from 'fs';
import * as path from 'path';
import type { Identity } from './types';

export function readIdentity(identityPath: string): Identity | null {
  try {
    const raw = fs.readFileSync(identityPath, { encoding: 'utf8' });
    const data = JSON.parse(raw) as Identity;
    if (typeof data.privateKey !== 'string' || typeof data.publicKey !== 'string') return null;
    return data;
  } catch {
    return null;
  }
}

export function writeIdentity(identityPath: string, identity: Identity): void {
  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  const tmp = `${identityPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, identityPath);
  // Ensure permissions survive rename on some filesystems
  try { fs.chmodSync(identityPath, 0o600); } catch { /* non-POSIX */ }
}

export function wipeIdentity(identityPath: string): void {
  try { fs.unlinkSync(identityPath); } catch { /* already gone */ }
}

export function isLinked(
  id: Identity | null,
): id is Identity & { deviceToken: string; accountId: string } {
  return id !== null && typeof id.deviceToken === 'string' && typeof id.accountId === 'string';
}
