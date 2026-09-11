import { backendApi } from './backendApi';

// backendApi.getActiveProfile / _normalizeProfile is the shared dependency
// every profile-aware widget goes through (via ProfileContext.useProfile()).
// Individual widgets (see widgets.test.jsx) already cover their own fetch
// failures; this covers the shared layer underneath all of them, and is
// also the front-end half of the 3.4 app<->backend contract check.
const response = data => ({ ok: true, json: async () => data });
afterEach(() => { jest.restoreAllMocks(); });

test('normalizes the real GET /api/mirrors/active-user shape (flat, camelCase)', async () => {
  // backend/src/routes/mirrors.js's GET /active-user always returns exactly
  // this flat shape — see profile: { id, name, settings, gmailConnected,
  // gmailEmail, spotifyConnected, spotifyDisplayName } — never a nested
  // `integrations: {...}` object.
  global.fetch = jest.fn(async () => response({
    profile: {
      id: 7, name: 'Alex',
      settings: { weather: false },
      gmailConnected: true, gmailEmail: 'alex@example.com',
      spotifyConnected: true, spotifyDisplayName: 'Alex S',
    },
    aiSettings: null,
  }));
  const profile = await backendApi.getActiveProfile('mirror-1');
  expect(profile.profileId).toBe(7);
  expect(profile.name).toBe('Alex');
  expect(profile.integrations).toEqual({
    gmail: { connected: true, email: 'alex@example.com' },
    spotify: { connected: true },
  });
  // settings merges onto defaults rather than replacing them wholesale.
  expect(profile.settings.weather).toBe(false);
  expect(profile.settings.wardrobe).toBe(true);
});

// _normalizeProfile also reads a nested `raw.integrations.spotify.connected` /
// `raw.integrations.gmail.connected` shape ahead of the flat fields. No
// backend endpoint that feeds getActiveProfile emits that nested shape (only
// the unrelated household-level /api/mirrors/integrations endpoint uses that
// word, for shared credentials, not per-profile connection status) — grepping
// the whole repo turns up no producer of it. Documented as dead code in
// E2E_FINDINGS.md rather than removed, since confirming a negative (no
// endpoint anywhere emits this) is a research finding, not something to
// silently delete from a shared normalizer.
test('nested integrations.* shape is prioritized when present, but no live endpoint sends it (documented dead code)', async () => {
  global.fetch = jest.fn(async () => response({
    profile: { id: 1, name: 'A', spotifyConnected: false, integrations: { spotify: { connected: true } } },
  }));
  const profile = await backendApi.getActiveProfile('mirror-1');
  expect(profile.integrations.spotify.connected).toBe(true); // nested wins when present...
  // ...but the real backend (see the test above) never sends `integrations`
  // on this endpoint, so in practice this branch never fires outside a test.
});

test('active-profile poll degrades safely (returns null, does not throw) when the backend is unreachable', async () => {
  global.fetch = jest.fn(async () => { throw new Error('Backend unreachable'); });
  await expect(backendApi.getActiveProfile('mirror-1')).resolves.toBeNull();
});

test('active-profile poll degrades safely on a non-OK HTTP response', async () => {
  global.fetch = jest.fn(async () => ({ ok: false, status: 503 }));
  await expect(backendApi.getActiveProfile('mirror-1')).resolves.toBeNull();
});

test('active-profile poll returns null (guest mode) without throwing when no profile is active', async () => {
  global.fetch = jest.fn(async () => response({ profile: null }));
  await expect(backendApi.getActiveProfile('mirror-1')).resolves.toBeNull();
});
