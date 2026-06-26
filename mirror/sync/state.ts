import * as fs from 'fs';
import * as path from 'path';
import type { MirrorState, StateCache } from './types';

export type { MirrorState, StateCache };

export function loadStateCache(cachePath: string): StateCache | null {
  try {
    const raw = fs.readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw) as StateCache;
    if (typeof parsed.version !== 'number' || !parsed.state) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveStateCache(cachePath: string, cache: StateCache): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  fs.renameSync(tmp, cachePath);
}

export function wipeStateCache(cachePath: string): void {
  try { fs.unlinkSync(cachePath); } catch { /* already gone */ }
}

/**
 * Deep-merge `changes` onto `state`. Arrays and primitives are replaced outright;
 * plain objects are merged recursively.
 */
export function applyDelta(state: MirrorState, changes: Partial<MirrorState>): MirrorState {
  return deepMerge(
    state as Record<string, unknown>,
    changes as Record<string, unknown>,
  ) as MirrorState;
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = result[key];
    if (
      sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
      tv !== null && typeof tv === 'object' && !Array.isArray(tv)
    ) {
      result[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>,
      );
    } else {
      result[key] = sv;
    }
  }
  return result;
}
