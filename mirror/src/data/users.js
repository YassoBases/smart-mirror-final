// ── Users data layer ──────────────────────────────────────────────────────────
// Stores user profiles and active user in smartMirrorSettings under the key
// "users". This keeps it alongside all other settings so existing backup/
// restore flows continue to work.
//
// Future phone-sync hook: when the phone app pushes a user list, call
//   mergeRemoteProfiles(remoteProfiles)
// and it will integrate without touching local-only profiles.

const STORAGE_KEY = 'smartMirrorSettings';
const USERS_KEY = 'users';

const DEFAULT_USERS_STATE = {
  activeUserId: null,
  profiles: []
};

// ── Internal read/write ───────────────────────────────────────────────────────

const readRaw = () => {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
};

const writeRaw = (root) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
};

// ── Migration: safely add users structure if missing ─────────────────────────
// Called once on app boot. Does NOT touch any other key in smartMirrorSettings.

const OLD_SEED_NAMES = new Set(['Dad', 'Mom', 'Guest']);

export const migrateUsersIfNeeded = () => {
  const root = readRaw();
  const existing = root[USERS_KEY];

  // First-time setup
  if (!existing || !Array.isArray(existing.profiles)) {
    root[USERS_KEY] = DEFAULT_USERS_STATE;
    writeRaw(root);
    return;
  }

  // Wipe old auto-seeded placeholder profiles (Dad/Mom/Guest with source:local)
  const hasOnlyOldSeeds =
    existing.profiles.length > 0 &&
    existing.profiles.every(p => p.source === 'local' && OLD_SEED_NAMES.has(p.name));

  if (hasOnlyOldSeeds) {
    root[USERS_KEY] = DEFAULT_USERS_STATE;
    writeRaw(root);
  }
};

// ── Change notification ───────────────────────────────────────────────────────

const notifyChange = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('storage'));
  }
};

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns the full users state { activeUserId, profiles }. */
export const getUsers = () => {
  migrateUsersIfNeeded();
  const root = readRaw();
  return root[USERS_KEY] || DEFAULT_USERS_STATE;
};

/** Returns the active user profile object, or the first profile as fallback. */
export const getActiveUser = () => {
  const { activeUserId, profiles } = getUsers();
  return profiles.find(p => p.id === activeUserId) || profiles[0] || null;
};

/** Switches the active user. Dispatches a custom event so other components react. */
export const setActiveUser = (userId) => {
  const root = readRaw();
  const usersState = root[USERS_KEY] || DEFAULT_USERS_STATE;

  if (!usersState.profiles.find(p => p.id === userId)) {
    console.warn('[Users] setActiveUser: unknown userId', userId);
    return;
  }

  usersState.activeUserId = userId;
  root[USERS_KEY] = usersState;
  writeRaw(root);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('smartMirror:activeUserChanged', {
        detail: { userId }
      })
    );
    window.dispatchEvent(new Event('storage'));
  }
};

/** Saves the full profiles array (e.g. after adding/editing a user). */
export const saveProfiles = (profiles) => {
  const root = readRaw();
  const usersState = root[USERS_KEY] || DEFAULT_USERS_STATE;
  usersState.profiles = profiles;

  // If the active user was deleted, fall back to the first profile.
  if (!profiles.find(p => p.id === usersState.activeUserId)) {
    usersState.activeUserId = profiles[0]?.id || null;
  }

  root[USERS_KEY] = usersState;
  writeRaw(root);
  notifyChange();

  return usersState;
};

// ── Face descriptor storage ───────────────────────────────────────────────────

const FACE_KEY = 'faceDescriptors';

/** Persists a single 128-dim face descriptor for a user. */
export const saveFaceDescriptor = (userId, descriptor) => {
  const root = readRaw();
  if (!root[FACE_KEY]) root[FACE_KEY] = {};
  root[FACE_KEY][userId] = [Array.from(descriptor)]; // always wrap in array
  writeRaw(root);
  notifyChange();
};

/**
 * Persists multiple 128-dim face descriptors for a user (multi-pose enrollment).
 * Replaces any previously stored descriptors for this user.
 */
export const saveFaceDescriptors = (userId, descriptors) => {
  const root = readRaw();
  if (!root[FACE_KEY]) root[FACE_KEY] = {};
  root[FACE_KEY][userId] = descriptors.map(d => Array.from(d));
  writeRaw(root);
  notifyChange();
};

/** Returns { [userId]: number[] } map of all stored descriptors. */
export const getFaceDescriptors = () => {
  const root = readRaw();
  return root[FACE_KEY] || {};
};

/** Removes the face descriptor for a user (e.g. when deleting profile). */
export const removeFaceDescriptor = (userId) => {
  const root = readRaw();
  if (root[FACE_KEY]) {
    delete root[FACE_KEY][userId];
    writeRaw(root);
    notifyChange();
  }
};

/**
 * Finds the best-matching user for a given descriptor using Euclidean distance.
 * Handles both single-descriptor (legacy number[]) and multi-descriptor (number[][]) storage.
 * Returns { user, distance } or null if no stored descriptors are below threshold.
 * Default threshold of 0.6 is face-api.js's documented good-match cutoff — strict
 * enough to reject strangers (typically > 0.65) while still recognising the owner
 * across lighting/pose variation (often 0.55–0.6).
 */
export const findUserByFace = (descriptor, threshold = 0.6) => {
  const stored = getFaceDescriptors();
  const { profiles } = getUsers();
  let bestUser = null;
  let bestDistance = Infinity;

  for (const [userId, storedEntry] of Object.entries(stored)) {
    if (!Array.isArray(storedEntry)) continue;
    // Normalize: stored as [[...], [...]] (new) or [...] (legacy single)
    const descriptorList = Array.isArray(storedEntry[0])
      ? storedEntry
      : [storedEntry];

    for (const storedDesc of descriptorList) {
      if (!Array.isArray(storedDesc) || storedDesc.length !== descriptor.length) continue;
      let sum = 0;
      for (let i = 0; i < descriptor.length; i++) {
        const diff = descriptor[i] - storedDesc[i];
        sum += diff * diff;
      }
      const dist = Math.sqrt(sum);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestUser = profiles.find(p => p.id === userId) || null;
      }
    }
  }

  return bestDistance < threshold ? { user: bestUser, distance: bestDistance } : null;
};

/**
 * Returns the Euclidean distance to the closest enrolled face, regardless of threshold.
 * Useful for attaching a confidence score to an unknown-face alert.
 * Returns null when no face descriptors are enrolled yet.
 */
export const findBestFaceDistance = (descriptor) => {
  const stored = getFaceDescriptors();
  let best = null;

  for (const storedEntry of Object.values(stored)) {
    if (!Array.isArray(storedEntry)) continue;
    const list = Array.isArray(storedEntry[0]) ? storedEntry : [storedEntry];
    for (const storedDesc of list) {
      if (!Array.isArray(storedDesc) || storedDesc.length !== descriptor.length) continue;
      let sum = 0;
      for (let i = 0; i < descriptor.length; i++) {
        const diff = descriptor[i] - storedDesc[i];
        sum += diff * diff;
      }
      const dist = Math.sqrt(sum);
      if (best === null || dist < best) best = dist;
    }
  }
  return best;
};

/**
 * Merges profiles received from the phone app.
 * Local-only profiles are preserved; remote profiles are upserted by id.
 * Future hook — call this when the phone sync payload arrives.
 */
export const mergeRemoteProfiles = (remoteProfiles = []) => {
  const { profiles: localProfiles, activeUserId } = getUsers();
  const merged = [...localProfiles];

  remoteProfiles.forEach(remote => {
    const idx = merged.findIndex(p => p.id === remote.id);
    if (idx >= 0) {
      merged[idx] = { ...merged[idx], ...remote, source: 'phone' };
    } else {
      merged.push({ ...remote, source: 'phone' });
    }
  });

  saveProfiles(merged);
  return { activeUserId, profiles: merged };
};
