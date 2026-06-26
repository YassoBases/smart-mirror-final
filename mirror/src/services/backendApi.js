// Mirror ↔ Backend API service
// Connects the mirror to the Node.js/Express backend for login, profiles, and user management.

// Use window.location.hostname so the phone browser's API calls go to the
// mirror's LAN IP (e.g. 192.168.1.25:3000) instead of localhost:3000.
// REACT_APP_API_URL overrides this for staging/production deployments.
const API_URL = (
  process.env.REACT_APP_API_URL ||
  `http://${window.location.hostname}:3000`
).replace(/\/$/, '');

const TOKEN_KEY = 'mirrorBackendToken';

export const backendApi = {
  // ── Auth ────────────────────────────────────────────────────────────────

  getToken: () => localStorage.getItem(TOKEN_KEY),

  isLoggedIn: () => !!localStorage.getItem(TOKEN_KEY),

  logout: () => {
    localStorage.removeItem(TOKEN_KEY);
    window.dispatchEvent(new Event('storage'));
  },

  /**
   * Clears the active user on this mirror so it returns to guest mode.
   * Removes both the explicit active_mirror_users entry and the profile's
   * mirror_id pointer so neither lookup path re-activates a profile.
   */
  signOutFromMirror: async (mirrorId) => {
    await fetch(`${API_URL}/api/mirrors/active-user?mid=${encodeURIComponent(mirrorId)}`, {
      method: 'DELETE',
    });
  },

  /**
   * Permanently deletes the currently active profile from the backend,
   * including all linked data (Gmail, Spotify, face images, AI settings).
   */
  deleteActiveProfile: async (mirrorId) => {
    const res = await fetch(
      `${API_URL}/api/mirrors/active-profile?mid=${encodeURIComponent(mirrorId)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Delete failed (HTTP ${res.status})`);
    }
    return res.json();
  },

  login: async (email, password) => {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.message || 'Login failed');
    localStorage.setItem(TOKEN_KEY, data.token);
    return data; // { token, accountId, householdId, email }
  },

  // ── Profiles ─────────────────────────────────────────────────────────────

  _authHeaders: () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
  }),

  getProfilesByMirror: async (mirrorId) => {
    const res = await fetch(`${API_URL}/api/mirror/${encodeURIComponent(mirrorId)}/profiles`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.profiles || [];
  },

  getProfiles: async () => {
    const res = await fetch(`${API_URL}/api/profiles`, {
      headers: backendApi._authHeaders(),
    });
    if (res.status === 401) { backendApi.logout(); throw new Error('Session expired'); }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to fetch profiles');
    return data; // [{ id, householdId, name, email, googleSub, createdAt }]
  },

  addProfile: async (name) => {
    const res = await fetch(`${API_URL}/api/profiles`, {
      method: 'POST',
      headers: backendApi._authHeaders(),
      body: JSON.stringify({ name }),
    });
    if (res.status === 401) { backendApi.logout(); throw new Error('Session expired'); }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add profile');
    return data; // { id, householdId, name, email, googleSub, createdAt }
  },

  // ── Mirror sync ───────────────────────────────────────────────────────────

  /**
   * Asks the backend for its LAN IPv4 + API base URL. The mirror is a browser
   * and can't read the Pi's network address, so the backend reports it.
   * Returns { apiBaseUrl, ip, port }. Used to embed the host in the pairing QR.
   */
  getNetInfo: async () => {
    let res;
    try {
      res = await fetch(`${API_URL}/api/mirror/netinfo`);
    } catch (e) {
      const err = new Error('Backend unreachable');
      err.backendDown = true;
      throw err;
    }
    if (res.status === 503) {
      const err = new Error('Mirror offline (no LAN IP)');
      err.offline = true;
      throw err;
    }
    if (!res.ok) throw new Error(`netinfo failed (HTTP ${res.status})`);
    return res.json();
  },

  /**
   * Returns the BLE provisioning state the Pi daemon publishes during WiFi setup:
   * { btName, state, pairingCode, pairingState }. Used by SetupMode (real BT name)
   * and PairingCodeOverlay (live 6-digit pairing code). Never throws — returns {}
   * when no setup is in progress or the backend is unreachable.
   */
  getBleStatus: async () => {
    try {
      const res = await fetch(`${API_URL}/api/mirror/ble-status`);
      if (!res.ok) return {};
      return await res.json();
    } catch {
      return {};
    }
  },

  /**
   * Returns this mirror's permanent ID (a UUID).
   * Generated once on first call and persisted in localStorage.
   * The phone app enters this ID to link itself to this mirror.
   */
  getMirrorId: () => {
    const MIRROR_ID_KEY = 'smartMirrorId';
    let id = localStorage.getItem(MIRROR_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(MIRROR_ID_KEY, id);
      console.log('[Mirror] Generated new Mirror ID:', id);
    } else {
      console.log('[Mirror] Loaded existing Mirror ID:', id);
    }
    return id;
  },

  /**
   * Polls the backend for whichever profile the phone app last activated.
   * Returns { id, name, email, gmailConnected, gmailEmail } or null.
   * No login needed — mirror identifies itself by its UUID.
   */
  getActiveUser: async (mirrorId) => {
    const url = `${API_URL}/api/mirrors/active-user?mid=${encodeURIComponent(mirrorId)}`;
    try {
      console.log('[Mirror] Polling:', url);
      const res = await fetch(url);
      if (!res.ok) {
        console.warn('[Mirror] Poll failed — HTTP', res.status, url);
        return null;
      }
      const data = await res.json();
      console.log('[Mirror] Poll response:', data);
      return data.profile || null;
    } catch (err) {
      console.warn('[Mirror] Poll error:', err.message, url);
      return null;
    }
  },

  /**
   * Reports an unknown-face detection to the backend, which stores the alert
   * and forwards a push notification to all registered phones in the household.
   * @param {string} mirrorId
   * @param {{ confidence?: number, imageData?: string }} options
   *   confidence — Euclidean distance from the closest enrolled face (lower = more similar).
   *   imageData  — Optional base64-encoded JPEG snapshot from the mirror camera.
   */
  reportUnknownFace: async (mirrorId, { confidence, imageData } = {}) => {
    try {
      await fetch(`${API_URL}/api/mirrors/${encodeURIComponent(mirrorId)}/unknown-face`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confidence: confidence ?? null,
          imageData:  imageData  ?? null,
        }),
      });
      console.log('[Mirror] Unknown-face alert sent');
    } catch (e) {
      console.warn('[Mirror] Alert send failed:', e.message);
    }
  },

  /**
   * Tells the backend which profile is now active on this mirror.
   * Called by the mirror when face recognition switches the active user.
   * Body: { mirrorId, profileId }
   */
  setActiveMirrorUser: async (mirrorId, profileId) => {
    try {
      await fetch(`${API_URL}/api/mirrors/active-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mirrorId, profileId }),
      });
    } catch (e) {
      console.warn('[Mirror] setActiveMirrorUser failed:', e.message);
    }
  },

  /**
   * Full profile fetch — same endpoint, richer normalized shape.
   * Handles both legacy { id, name, gmailConnected } and the full
   * { settings, integrations, location, preferences } backend shape.
   * Returns a normalized activeProfile object or null.
   */
  getActiveProfile: async (mirrorId) => {
    const url = `${API_URL}/api/mirrors/active-user?mid=${encodeURIComponent(mirrorId)}`;
    try {
      console.log('[Profile] Polling:', url, '| mirrorId:', mirrorId);
      const res = await fetch(url);
      if (!res.ok) {
        console.warn('[Profile] Poll failed — HTTP', res.status);
        return null;
      }
      const data = await res.json();
      const raw = data.profile || null;
      console.log('[Profile] Raw response:', raw);

      if (!raw) return null;

      const normalized = backendApi._normalizeProfile(raw);
      console.log('[Profile] Settings received:', normalized.settings);
      console.log('[Profile] Integrations received:', normalized.integrations);
      console.log('[Profile] Location received:', normalized.location);
      return { ...normalized, aiSettings: data.aiSettings || null };
    } catch (err) {
      console.warn('[Profile] Poll error:', err.message);
      return null;
    }
  },

  // Normalizes both legacy and full backend profile shapes into one structure
  _normalizeProfile: (raw) => {
    const defaults = {
      settings: { datetime: true, weather: true, news: true, gmail: false, spotify: false },
      integrations: { gmail: { connected: false, email: null }, spotify: { connected: false } },
      location: { city: 'Istanbul', country: null, lat: null, lon: null },
      preferences: { units: 'celsius', newsSources: ['bbc', 'trt'], language: 'en' },
    };

    const gmailConnected = !!(
      raw.integrations?.gmail?.connected ?? raw.gmailConnected ?? false
    );
    const gmailEmail = raw.integrations?.gmail?.email || raw.gmailEmail || null;
    const spotifyConnected = !!(raw.integrations?.spotify?.connected ?? raw.spotifyConnected ?? false);

    return {
      profileId:  raw.id,
      name:       raw.name || null,
      settings: {
        ...defaults.settings,
        ...(raw.settings || {}),
        // gmail/spotify visibility follows the phone toggle (carried in raw.settings),
        // NOT OAuth connection status. Connection status lives in `integrations` below and
        // only controls whether each widget shows live data or a "not connected" placeholder.
      },
      integrations: {
        gmail:   { connected: gmailConnected, email: gmailEmail },
        spotify: { connected: spotifyConnected },
      },
      location: {
        city:    raw.location?.city    || defaults.location.city,
        country: raw.location?.country || null,
        lat:     raw.location?.lat     || null,
        lon:     raw.location?.lon     || null,
      },
      preferences: {
        units:       raw.preferences?.units       || defaults.preferences.units,
        newsSources: raw.preferences?.newsSources || defaults.preferences.newsSources,
        language:    raw.preferences?.language    || defaults.preferences.language,
      },
    };
  },

  // ── Integrations (Replicate API key, etc.) ────────────────────────────────
  // Stored server-side (renders run on the backend). GET never returns the
  // secret — only whether it is configured.

  getIntegrations: async () => {
    try {
      const res = await fetch(`${API_URL}/api/mirrors/integrations`);
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  },

  saveIntegrations: async (payload) => {
    const res = await fetch(`${API_URL}/api/mirrors/integrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Save failed (HTTP ${res.status})`);
    return data;
  },
};

// Map backend profile shape → mirror profile shape
export const toMirrorProfile = (backendProfile) => ({
  id: String(backendProfile.id),
  name: backendProfile.name,
  source: 'backend',
  gmailConnected: !!(backendProfile.email && backendProfile.googleSub),
  gmailEmail: backendProfile.email || null,
  backendId: backendProfile.id,
});
