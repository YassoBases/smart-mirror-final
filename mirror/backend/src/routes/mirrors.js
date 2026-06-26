const router = require('express').Router();
const { getDb } = require('../config/database');
const gmailService = require('../services/gmailService');
const spotifyService = require('../services/spotifyService');
const { pairSession, pairByCode } = require('../services/mirrorSync');
const { authenticate } = require('../middleware/auth');
const { sendToHousehold } = require('../services/pushService');
const { getSetting, setSetting, getSharedSettings, setSharedSettings } = require('../services/settingsService');
const profileService = require('../services/profileService');

// ── Integration settings (set from the mirror Settings UI) ───────────────────
// Stores the Replicate API token (and optional VTON model + public base URL) in
// the DB so they don't have to live in backend/.env. Unauthenticated like the
// other mirror endpoints — a local/LAN read-write on the personal mirror. The
// GET never returns the secret value, only whether it is configured.
// Returns the full shared household settings. includeSecrets: the mirror's voice
// assistant calls OpenAI directly in the browser, so it needs the raw key (this
// is a local/LAN read on the personal mirror — same exposure as before). A legacy
// `replicate` block is kept for back-compat.
function withLegacy(s) {
  return {
    ...s,
    replicate: { configured: !!s.replicateApiTokenConfigured, model: s.replicateModel || '' },
    publicBaseUrl: s.publicBaseUrl || '',
  };
}

router.get('/integrations', async (_req, res, next) => {
  try {
    res.json(withLegacy(await getSharedSettings({ includeSecrets: true })));
  } catch (err) {
    next(err);
  }
});

router.post('/integrations', async (req, res, next) => {
  try {
    await setSharedSettings(req.body || {});
    res.json({ ok: true, ...withLegacy(await getSharedSettings({ includeSecrets: true })) });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/mirrors/pair ────────────────────────────────────────────────────
// Phone calls this after scanning the mirror's QR code.
// Body: { sid, shortCode, phonePublicKey? }
// Auth: Bearer JWT (required — ties the mirror to the phone owner's account)
router.post('/pair', authenticate, async (req, res, next) => {
  try {
    const { sid, shortCode, phonePublicKey } = req.body;
    if (!sid || !shortCode) {
      return res.status(400).json({ error: 'sid and shortCode are required' });
    }
    const { mirrorId, deviceToken } = await pairSession(
      sid, shortCode, req.account.accountId, phonePublicKey
    );
    res.json({ mirrorId, deviceToken });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/mirrors/pair/code ───────────────────────────────────────────────
// Alternative pairing when the phone can't scan the QR (emulator, no camera).
// The user reads the 6-character short code shown on the mirror and types it here.
// Body: { shortCode }
// Auth: Bearer JWT
router.post('/pair/code', authenticate, async (req, res, next) => {
  try {
    const { shortCode, phonePublicKey } = req.body;
    if (!shortCode) {
      return res.status(400).json({ error: 'shortCode is required' });
    }
    const { mirrorId, deviceToken } = await pairByCode(
      shortCode, req.account.accountId, phonePublicKey
    );
    res.json({ mirrorId, deviceToken });
  } catch (err) {
    next(err);
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────

// Resolve mirrorId → profile row (with gmail_connected flag).
// Checks active_mirror_users first (explicit selection on mirror),
// then falls back to profiles.mirror_id (app-side pairing).
// Returns null when nothing is linked.
async function getActiveProfile(mirrorId) {
  const db = await getDb();

  const SELECT = `
    SELECT p.id, p.name, p.email, p.google_sub, p.mirror_id, p.widgets_config, p.ai_settings,
           CASE WHEN gc.profile_id  IS NOT NULL THEN 1 ELSE 0 END AS gmail_connected,
           CASE WHEN sc.profile_id  IS NOT NULL THEN 1 ELSE 0 END AS spotify_connected,
           sc.display_name AS spotify_display_name
    FROM profiles p
    LEFT JOIN gmail_connections   gc ON gc.profile_id = p.id
    LEFT JOIN spotify_connections sc ON sc.profile_id = p.id
  `;

  // Primary: explicitly selected active user
  const fromActive = await db.get(
    `${SELECT} JOIN active_mirror_users amu ON amu.profile_id = p.id WHERE amu.mirror_id = ?`,
    mirrorId
  );
  if (fromActive) return fromActive;

  // Fallback: profile linked via app (profiles.mirror_id)
  return db.get(
    `${SELECT} WHERE p.mirror_id = ? ORDER BY p.name LIMIT 1`,
    mirrorId
  );
}

// ── DELETE /api/mirrors/active-user?mid=<mirrorId> ───────────────────────────
// Clears the active user for this mirror → mirror returns to guest mode.
// No auth required; mirrorId is the only key needed.
router.delete('/active-user', async (req, res, next) => {
  try {
    const mirrorId = req.query.mid;
    if (!mirrorId) return res.status(400).json({ error: 'mid is required' });
    const db = await getDb();
    await db.run('DELETE FROM active_mirror_users WHERE mirror_id = ?', mirrorId);
    // Unlink profiles that still point to this mirror so the fallback lookup
    // doesn't automatically re-activate one of them.
    await db.run('UPDATE profiles SET mirror_id = NULL WHERE mirror_id = ?', mirrorId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/mirrors/active-profile?mid=<mirrorId> ───────────────────────
// Permanently deletes the active profile (and all its data via cascade).
// No auth required; authorization is implicit — only someone with the mirrorId
// can trigger this.
router.delete('/active-profile', async (req, res, next) => {
  try {
    const mirrorId = req.query.mid;
    if (!mirrorId) return res.status(400).json({ error: 'mid is required' });
    const db = await getDb();
    const profile = await getActiveProfile(mirrorId);
    if (!profile) return res.status(404).json({ error: 'No active profile on this mirror' });
    await db.run('DELETE FROM profiles WHERE id = ?', profile.id);
    res.json({ ok: true, deletedProfileId: profile.id });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/mirrors/active-profile?mid=<mirrorId> ─────────────────────────
// Edit the active profile's name/email FROM the mirror, persisting to the backend
// so the phone app sees the change. No JWT (LAN mirror), like the other mid routes.
router.patch('/active-profile', async (req, res, next) => {
  try {
    const mirrorId = req.query.mid;
    if (!mirrorId) return res.status(400).json({ error: 'mid is required' });
    const profile = await getActiveProfile(mirrorId);
    if (!profile) return res.status(404).json({ error: 'No active profile on this mirror' });
    const { name, email } = req.body || {};
    if (name !== undefined && (!name || !String(name).trim())) {
      return res.status(400).json({ error: 'Profile name cannot be empty' });
    }
    const updated = await profileService.updateProfile(profile.id, { name, email });
    res.json({ profile: updated });
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/mirrors/active-profile/widgets?mid=<mirrorId> ─────────────────
// Persist a widget-visibility change made on the mirror back to the backend.
router.patch('/active-profile/widgets', async (req, res, next) => {
  try {
    const mirrorId = req.query.mid;
    if (!mirrorId) return res.status(400).json({ error: 'mid is required' });
    const profile = await getActiveProfile(mirrorId);
    if (!profile) return res.status(404).json({ error: 'No active profile on this mirror' });
    const { widgets } = req.body || {};
    if (!widgets || typeof widgets !== 'object') {
      return res.status(400).json({ error: 'widgets object is required' });
    }
    const updated = await profileService.updateWidgets(profile.id, widgets);
    res.json({ profile: updated });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/mirrors/active-user ─────────────────────────────────────────────
// Body: { mirrorId, profileId }
// Called by the mirror when a user selects their profile on the mirror itself.
router.post('/active-user', async (req, res, next) => {
  try {
    const { mirrorId, profileId } = req.body;
    if (!mirrorId || !profileId) {
      return res.status(400).json({ error: 'mirrorId and profileId are required' });
    }

    const db = await getDb();

    // Verify the profile exists
    const profile = await db.get('SELECT id FROM profiles WHERE id = ?', profileId);
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    await db.run(
      `INSERT INTO active_mirror_users (mirror_id, profile_id, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(mirror_id) DO UPDATE SET
         profile_id = excluded.profile_id,
         updated_at = CURRENT_TIMESTAMP`,
      mirrorId, profileId
    );

    await db.run('UPDATE profiles SET mirror_id = ? WHERE id = ?', mirrorId, profileId);

    const active = await getActiveProfile(mirrorId);
    const widgetSettings = active.widgets_config ? JSON.parse(active.widgets_config) : undefined;
    const aiSettings = active.ai_settings ? JSON.parse(active.ai_settings) : null;
    res.json({
      profile: {
        id: active.id,
        name: active.name,
        settings:             widgetSettings,
        gmailConnected:       !!active.gmail_connected,
        gmailEmail:           active.email || null,
        spotifyConnected:     !!active.spotify_connected,
        spotifyDisplayName:   active.spotify_display_name || null,
      },
      aiSettings,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/mirrors/active-user?mid=<mirrorId> ───────────────────────────────
// Polled by the mirror UI to know who is the active user.
// mirrorId is passed as query param ?mid= to avoid URL path issues with
// base64 keys that contain '/' and '+'.
router.get('/active-user', async (req, res, next) => {
  try {
    const mirrorId = req.query.mid;
    if (!mirrorId) return res.json({ profile: null });
    const profile = await getActiveProfile(mirrorId);
    if (!profile) return res.json({ profile: null });
    const widgetSettings = profile.widgets_config ? JSON.parse(profile.widgets_config) : undefined;
    const aiSettings = profile.ai_settings ? JSON.parse(profile.ai_settings) : null;
    res.json({
      profile: {
        id: profile.id,
        name: profile.name,
        settings:           widgetSettings,
        gmailConnected:     !!profile.gmail_connected,
        gmailEmail:         profile.email || null,
        spotifyConnected:   !!profile.spotify_connected,
        spotifyDisplayName: profile.spotify_display_name || null,
      },
      aiSettings,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/mirrors/gmail/status?mid=<mirrorId> ──────────────────────────────
router.get('/gmail/status', async (req, res, next) => {
  try {
    const profile = await getActiveProfile(req.query.mid);
    if (!profile) return res.json({ connected: false, email: null });
    res.json({ connected: !!profile.gmail_connected, email: profile.email || null });
  } catch (err) { next(err); }
});

// ── GET /api/mirrors/gmail/messages?mid=<mirrorId> ────────────────────────────
router.get('/gmail/messages', async (req, res, next) => {
  try {
    const profile = await getActiveProfile(req.query.mid);
    if (!profile || !profile.gmail_connected) return res.json({ messages: [] });
    const messages = await gmailService.getInboxSummary(profile.id);
    res.json({ messages });
  } catch (err) {
    if (err.status === 404) return res.json({ messages: [] });
    next(err);
  }
});

// ── GET /api/mirrors/spotify/status?mid=<mirrorId> ────────────────────────────
router.get('/spotify/status', async (req, res, next) => {
  try {
    const profile = await getActiveProfile(req.query.mid);
    if (!profile) return res.json({ connected: false, displayName: null });
    res.json({ connected: !!profile.spotify_connected, displayName: profile.spotify_display_name || null });
  } catch (err) { next(err); }
});

// ── GET /api/mirrors/spotify/now-playing?mid=<mirrorId> ───────────────────────
router.get('/spotify/now-playing', async (req, res, next) => {
  try {
    const profile = await getActiveProfile(req.query.mid);
    if (!profile || !profile.spotify_connected) return res.json({ track: null });
    const track = await spotifyService.getCurrentlyPlaying(profile.id);
    res.json({ track });
  } catch (err) {
    if (err.status === 404) return res.json({ track: null });
    next(err);
  }
});

// ── Retry helper — retries a fetch on transient network failures ──────────────
async function fetchWithRetry(url, options, retries = 3, delayMs = 600) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ── GET /api/mirrors/spotify/player?mid=<mirrorId> ────────────────────────────
router.get('/spotify/player', async (req, res) => {
  try {
    const profile = await getActiveProfile(req.query.mid);
    if (!profile || !profile.spotify_connected) {
      return res.json({ connected: false });
    }

    // getFreshToken auto-refreshes expired tokens — always call this, never use cached token directly
    let token;
    try {
      token = await spotifyService.getFreshToken(profile.id);
    } catch (e) {
      console.warn('[mirrors] getFreshToken failed:', e.message);
      // Token error = genuinely disconnected
      return res.json({ connected: false });
    }

    let spotifyRes;
    try {
      spotifyRes = await fetchWithRetry('https://api.spotify.com/v1/me/player', {
        headers: { 'Authorization': `Bearer ${token}` },
      });
    } catch (netErr) {
      // Transient network failure — keep showing as connected with no playback update
      console.warn('[mirrors] spotify/player network error (retries exhausted):', netErr.message);
      return res.json({
        connected:    true,
        displayName:  profile.spotify_display_name || '',
        networkError: true,
        is_playing:   false,
        item:         null,
      });
    }

    // 204 = no active device registered with Spotify — common on mobile / free accounts.
    // Fall back to /currently-playing which works without an active device.
    if (spotifyRes.status === 204) {
      let cpRes;
      try {
        cpRes = await fetchWithRetry('https://api.spotify.com/v1/me/player/currently-playing', {
          headers: { 'Authorization': `Bearer ${token}` },
        });
      } catch (netErr) {
        console.warn('[mirrors] spotify/currently-playing network error:', netErr.message);
        return res.json({ connected: true, displayName: profile.spotify_display_name || '', networkError: true, is_playing: false, item: null });
      }
      if (!cpRes.ok || cpRes.status === 204) {
        return res.json({ connected: true, displayName: profile.spotify_display_name || '', is_playing: false, item: null });
      }
      const cp = await cpRes.json();
      return res.json({
        connected:   true,
        displayName: profile.spotify_display_name || '',
        is_playing:  cp.is_playing ?? false,
        item:        cp.item ?? null,
        progress_ms: cp.progress_ms ?? 0,
      });
    }

    if (!spotifyRes.ok) {
      // 403 = Spotify Premium required or dev-mode restriction — user IS connected, just no playback data
      // 401 = token genuinely invalid — treat as not connected
      console.warn('[mirrors] Spotify player returned %d', spotifyRes.status);
      if (spotifyRes.status === 401) return res.json({ connected: false });
      return res.json({
        connected:   true,
        displayName: profile.spotify_display_name || '',
        is_playing:  false,
        item:        null,
      });
    }

    // Return raw Spotify response — mirror widget normalizes field names itself
    const player = await spotifyRes.json();
    res.json({
      connected:   true,
      displayName: profile.spotify_display_name || '',
      ...player,
    });
  } catch (err) {
    console.error('[mirrors] spotify/player error:', err.message);
    // Unknown error — keep connected state to avoid wiping the display
    res.json({ connected: true, displayName: '', networkError: true, is_playing: false, item: null });
  }
});

// ── POST /api/mirrors/spotify/control ────────────────────────────────────────
// Body: { mid: mirrorId, action: 'play' | 'pause' | 'next' | 'previous' }
router.post('/spotify/control', async (req, res) => {
  try {
    const profile = await getActiveProfile(req.body.mid);
    if (!profile || !profile.spotify_connected) {
      return res.status(403).json({ error: 'No Spotify session for this mirror' });
    }

    let token;
    try {
      token = await spotifyService.getFreshToken(profile.id);
    } catch (e) {
      return res.status(403).json({ error: 'Spotify token unavailable' });
    }

    const { action } = req.body;
    const endpointMap = {
      play:     { url: 'https://api.spotify.com/v1/me/player/play',     method: 'PUT' },
      pause:    { url: 'https://api.spotify.com/v1/me/player/pause',    method: 'PUT' },
      next:     { url: 'https://api.spotify.com/v1/me/player/next',     method: 'POST' },
      previous: { url: 'https://api.spotify.com/v1/me/player/previous', method: 'POST' },
    };

    const ep = endpointMap[action];
    if (!ep) return res.status(400).json({ error: 'Unknown action' });

    await fetch(ep.url, {
      method: ep.method,
      headers: { 'Authorization': `Bearer ${token}` },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[mirrors] spotify/control error:', err.message);
    res.status(500).json({ error: 'Spotify control failed' });
  }
});

// ── GET /api/mirrors/spotify/devices?mid=<mirrorId> ──────────────────────────
// Returns all available Spotify Connect devices for the active user.
router.get('/spotify/devices', async (req, res) => {
  try {
    const profile = await getActiveProfile(req.query.mid);
    if (!profile || !profile.spotify_connected) return res.json({ devices: [] });

    let token;
    try { token = await spotifyService.getFreshToken(profile.id); } catch (e) { return res.json({ devices: [] }); }

    const r = await fetch('https://api.spotify.com/v1/me/player/devices', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) return res.json({ devices: [] });
    const data = await r.json();
    res.json({ devices: data.devices || [] });
  } catch (err) {
    console.error('[mirrors] spotify/devices error:', err.message);
    res.json({ devices: [] });
  }
});

// ── POST /api/mirrors/spotify/transfer ───────────────────────────────────────
// Body: { mid, deviceId, play? }
// Transfers Spotify playback to the specified device.
router.post('/spotify/transfer', async (req, res) => {
  try {
    const profile = await getActiveProfile(req.body.mid);
    if (!profile || !profile.spotify_connected) {
      return res.status(403).json({ error: 'No Spotify session for this mirror' });
    }

    let token;
    try { token = await spotifyService.getFreshToken(profile.id); } catch (e) {
      return res.status(403).json({ error: 'Spotify token unavailable' });
    }

    const { deviceId, play = true } = req.body;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });

    const r = await fetch('https://api.spotify.com/v1/me/player', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_ids: [deviceId], play }),
    });

    if (!r.ok && r.status !== 204) {
      const body = await r.json().catch(() => ({}));
      return res.status(r.status).json({ error: body.error?.message || 'Transfer failed' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[mirrors] spotify/transfer error:', err.message);
    res.status(500).json({ error: 'Transfer failed' });
  }
});

// ── GET /api/mirrors/spotify/web-player-token?mid=<mirrorId> ─────────────────
// Returns a fresh access token for use by the Spotify Web Playback SDK in the
// mirror browser. The SDK calls this internally via getOAuthToken().
router.get('/spotify/web-player-token', async (req, res) => {
  try {
    const profile = await getActiveProfile(req.query.mid);
    if (!profile || !profile.spotify_connected) {
      return res.status(403).json({ error: 'Not connected' });
    }
    let token;
    try { token = await spotifyService.getFreshToken(profile.id); } catch (e) {
      return res.status(403).json({ error: 'Token unavailable' });
    }
    res.json({ access_token: token });
  } catch (err) {
    console.error('[mirrors] spotify/web-player-token error:', err.message);
    res.status(500).json({ error: 'Token fetch failed' });
  }
});

// ── POST /api/mirrors/spotify/play-track ─────────────────────────────────────
// Body: { mid: mirrorId, query: 'song or artist name' }
// Searches Spotify for the top matching track and starts playback.
router.post('/spotify/play-track', async (req, res) => {
  try {
    const profile = await getActiveProfile(req.body.mid);
    if (!profile || !profile.spotify_connected) {
      return res.status(403).json({ error: 'No Spotify session for this mirror' });
    }

    let token;
    try {
      token = await spotifyService.getFreshToken(profile.id);
    } catch (e) {
      return res.status(403).json({ error: 'Spotify token unavailable' });
    }

    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query' });

    const searchRes = await fetch(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    if (!searchRes.ok) return res.status(502).json({ error: 'Spotify search failed' });
    const searchData = await searchRes.json();
    const track = searchData.tracks?.items?.[0];
    if (!track) return res.status(404).json({ error: `No track found for "${query}"` });

    await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [track.uri] }),
    });

    res.json({
      ok:    true,
      track: { name: track.name, artist: track.artists.map(a => a.name).join(', ') },
    });
  } catch (err) {
    console.error('[mirrors] spotify/play-track error:', err.message);
    res.status(500).json({ error: 'Spotify play failed' });
  }
});

// ── POST /api/mirrors/:mirrorId/unknown-face ──────────────────────────────────
// Called by the mirror when face recognition sees an unknown person.
// No auth — mirror-side fire-and-forget; resolved to household via mirror_id.
// Optional body: { confidence: number, imageData: string (base64 JPEG) }
router.post('/:mirrorId/unknown-face', async (req, res, next) => {
  try {
    const { mirrorId } = req.params;
    const { confidence, imageData } = req.body || {};
    const db = await getDb();

    const row = await db.get(
      `SELECT a.household_id
       FROM mirrors m
       JOIN accounts a ON a.id = m.account_id
       WHERE m.mirror_id = ?`,
      mirrorId,
    );

    if (!row) return res.status(404).json({ error: 'Mirror not found' });

    // Save optional image snapshot
    let imagePath = null;
    if (imageData && typeof imageData === 'string') {
      const fs   = require('fs');
      const path = require('path');
      const dir  = path.join(__dirname, '../../data/alert-snapshots');
      fs.mkdirSync(dir, { recursive: true });
      const filename = `alert_${Date.now()}_${String(mirrorId).slice(0, 8)}.jpg`;
      try {
        fs.writeFileSync(path.join(dir, filename), Buffer.from(imageData, 'base64'));
        imagePath = filename;
      } catch (imgErr) {
        console.warn('[mirrors] Failed to save alert snapshot:', imgErr.message);
      }
    }

    // Persist alert so the phone can fetch it even after missing the push notification
    const result = await db.run(
      `INSERT INTO security_alerts (household_id, mirror_id, alert_type, confidence, image_path)
       VALUES (?, ?, 'UNKNOWN_FACE_DETECTED', ?, ?)`,
      row.household_id, mirrorId, confidence ?? null, imagePath,
    );
    const alertId = result.lastID;
    console.log(`[mirrors] Security alert #${alertId} stored for household ${row.household_id}`);

    await sendToHousehold(row.household_id, {
      title: 'Security Alert',
      body:  'Unknown face detected at your mirror',
      data: {
        alertId:   String(alertId),
        alertType: 'UNKNOWN_FACE_DETECTED',
        mirrorId,
        timestamp: new Date().toISOString(),
      },
    });

    res.json({ ok: true, alertId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
