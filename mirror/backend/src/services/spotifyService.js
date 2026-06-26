const { getDb } = require('../config/database');

const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/authorize';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_ME_URL   = 'https://api.spotify.com/v1/me';
const SCOPES = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-read-currently-playing',
  'user-modify-playback-state',
  'streaming',
].join(' ');

function clientId()     { return process.env.SPOTIFY_CLIENT_ID; }
function clientSecret() { return process.env.SPOTIFY_CLIENT_SECRET; }
function redirectUri()  { return process.env.SPOTIFY_REDIRECT_URI; }

function basicAuth() {
  return Buffer.from(`${clientId()}:${clientSecret()}`).toString('base64');
}

// ── Auth URL ─────────────────────────────────────────────────────────────────

function getAuthUrl(profileId) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId(),
    scope:         SCOPES,
    redirect_uri:  redirectUri(),
    state:         String(profileId),
    show_dialog:   'true',   // always show so user can switch accounts
  });
  return `${SPOTIFY_AUTH_URL}?${params}`;
}

// ── OAuth callback ────────────────────────────────────────────────────────────

async function handleCallback(code, profileId) {
  const db = await getDb();

  const profile = await db.get('SELECT id, name FROM profiles WHERE id = ?', profileId);
  if (!profile) throw Object.assign(new Error('Profile not found'), { status: 404 });

  // Exchange code for tokens
  const tokenRes = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth()}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }),
  });

  const tokenText = await tokenRes.text();
  let tokens;
  try {
    tokens = JSON.parse(tokenText);
  } catch (e) {
    console.error('[Spotify] token exchange returned non-JSON:', tokenText.slice(0, 300));
    throw Object.assign(new Error('Spotify authorization failed. Please try again.'), { status: 502 });
  }

  if (!tokenRes.ok) {
    throw Object.assign(new Error(tokens.error_description || tokens.error || 'Spotify authorization failed'), { status: 400 });
  }
  if (!tokens.refresh_token) {
    throw Object.assign(new Error('No refresh token returned. Please disconnect and try again.'), { status: 400 });
  }

  // Try to fetch Spotify user profile — optional.
  // Spotify Development Mode may block /v1/me with 403 even for valid tokens.
  // If it fails we still save the connection; display name falls back to profile name.
  let spotifyUserId = `profile_${profileId}`;
  let displayName   = profile.name;

  try {
    const meRes  = await fetch(SPOTIFY_ME_URL, {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });
    const meText = await meRes.text();
    if (meRes.ok) {
      const me  = JSON.parse(meText);
      spotifyUserId = me.id   || spotifyUserId;
      displayName   = me.display_name || me.id || displayName;
    } else {
      console.warn('[Spotify] /me returned %d — saving connection with profile name as display name. Body: %s',
        meRes.status, meText.slice(0, 200));
    }
  } catch (e) {
    console.warn('[Spotify] /me fetch error (non-fatal):', e.message);
  }

  // ── /me is NOT required for saving the connection ──────────────────────────

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await db.run(
    `INSERT INTO spotify_connections
       (profile_id, access_token, refresh_token, expires_at, spotify_user_id, display_name)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       access_token    = excluded.access_token,
       refresh_token   = excluded.refresh_token,
       expires_at      = excluded.expires_at,
       spotify_user_id = excluded.spotify_user_id,
       display_name    = excluded.display_name,
       connected_at    = CURRENT_TIMESTAMP`,
    profileId,
    tokens.access_token,
    tokens.refresh_token,
    expiresAt,
    spotifyUserId,
    displayName
  );

  return { displayName, spotifyUserId };
}

// ── Get fresh access token (auto-refresh) ────────────────────────────────────

async function getFreshToken(profileId) {
  const db = await getDb();
  const conn = await db.get(
    'SELECT * FROM spotify_connections WHERE profile_id = ?', profileId
  );
  if (!conn) throw Object.assign(new Error('No Spotify connection for this profile'), { status: 404 });

  // Return existing token if still valid (with 60s buffer)
  if (new Date(conn.expires_at) > new Date(Date.now() + 60_000)) {
    return conn.access_token;
  }

  // Refresh
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth()}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: conn.refresh_token,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error('Failed to refresh Spotify token'), { status: 401 });

  const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
  await db.run(
    `UPDATE spotify_connections
     SET access_token = ?, expires_at = ?
     WHERE profile_id = ?`,
    data.access_token, expiresAt, profileId
  );
  return data.access_token;
}

// ── Status (safe — no tokens) ─────────────────────────────────────────────────

async function getStatus(profileId) {
  const db = await getDb();
  const conn = await db.get(
    'SELECT display_name, spotify_user_id, connected_at FROM spotify_connections WHERE profile_id = ?',
    profileId
  );
  if (!conn) return { connected: false, displayName: null };
  return { connected: true, displayName: conn.display_name };
}

// ── Currently playing ─────────────────────────────────────────────────────────

async function getCurrentlyPlaying(profileId) {
  const token = await getFreshToken(profileId);
  const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 204 || res.status === 404) return null; // nothing playing
  if (!res.ok) throw Object.assign(new Error('Failed to fetch Spotify playback'), { status: 502 });
  const data = await res.json();
  if (!data || !data.item) return null;
  return {
    isPlaying:  data.is_playing,
    trackName:  data.item.name,
    artistName: data.item.artists.map((a) => a.name).join(', '),
    albumArt:   data.item.album?.images?.[0]?.url || null,
    progressMs: data.progress_ms,
    durationMs: data.item.duration_ms,
  };
}

// ── Disconnect ────────────────────────────────────────────────────────────────

async function disconnect(profileId) {
  const db = await getDb();
  await db.run('DELETE FROM spotify_connections WHERE profile_id = ?', profileId);
}

module.exports = { getAuthUrl, handleCallback, getFreshToken, getStatus, getCurrentlyPlaying, disconnect };
