const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { getDb } = require('../config/database');

// In-memory stores (cleared on server restart — mirrors will re-pair or re-auth)
const pairingSessions = new Map(); // sid → { ws, mirrorPublicKey, shortCode, expiresAt }
const connectedMirrors = new Map(); // deviceToken → ws

function start(port) {
  // Bind to '::' so the server accepts both IPv4 (127.0.0.1) and IPv6 (::1)
  // connections — on Windows, 'localhost' often resolves to ::1.
  const wss = new WebSocketServer({ port, host: '::' });
  wss.on('connection', (ws, req) => {
    const remoteAddr = req.socket.remoteAddress;
    console.log(`[mirrorSync] mirror connected from ${remoteAddr}`);
    ws._mirror = {};
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      console.log(`[mirrorSync] → ${msg.type}`);
      handleMessage(ws, msg);
    });
    ws.on('close', () => {
      console.log(`[mirrorSync] mirror disconnected (addr=${remoteAddr})`);
      cleanup(ws);
    });
    ws.on('error', (err) => console.error('[mirrorSync] ws error:', err.message));
  });
  console.log(`[mirrorSync] WebSocket server listening on ws://[::]:${port} (IPv4+IPv6)`);
  return wss;
}

function cleanup(ws) {
  const { deviceToken, sid } = ws._mirror;
  if (deviceToken) connectedMirrors.delete(deviceToken);
  if (sid) pairingSessions.delete(sid);
}

function send(ws, msg) {
  if (ws.readyState === 1) {
    console.log(`[mirrorSync] ← ${msg.type}`);
    ws.send(JSON.stringify(msg));
  }
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'hello': {
      const sid = randomUUID();
      pairingSessions.set(sid, {
        ws,
        mirrorPublicKey: msg.mirror_public_key,
        shortCode:       msg.short_code,
        expiresAt:       Date.now() + 300_000,
      });
      ws._mirror.sid = sid;
      send(ws, { type: 'pairing_session', sid, expires_in: 300 });
      break;
    }

    case 'refresh_session': {
      const { sid: oldSid } = ws._mirror;
      const session = pairingSessions.get(oldSid);
      if (!session) return;
      pairingSessions.delete(oldSid);
      const newSid = randomUUID();
      session.shortCode = msg.new_short_code;
      session.expiresAt = Date.now() + 300_000;
      pairingSessions.set(newSid, session);
      ws._mirror.sid = newSid;
      send(ws, { type: 'pairing_session', sid: newSid, expires_in: 300 });
      break;
    }

    case 'auth':
      handleAuth(ws, msg.device_token);
      break;

    case 'resync':
      send(ws, { type: 'snapshot', version: 1, state: { modules: {} } });
      break;

    case 'ping':
      send(ws, { type: 'pong' });
      break;
  }
}

async function handleAuth(ws, deviceToken) {
  try {
    const db = await getDb();
    const mirror = await db.get(
      'SELECT mirror_id, account_id FROM mirrors WHERE device_token = ?',
      deviceToken
    );
    if (!mirror) {
      send(ws, { type: 'unlinked' });
      return;
    }
    ws._mirror.deviceToken = deviceToken;
    ws._mirror.mirrorId    = mirror.mirror_id;
    ws._mirror.accountId   = mirror.account_id;
    connectedMirrors.set(deviceToken, ws);
    send(ws, { type: 'auth_ok' });
  } catch (err) {
    console.error('[mirrorSync] auth error:', err.message);
  }
}

/**
 * Called by POST /api/mirrors/pair.
 * Validates the pairing session, records the mirror in the DB,
 * sends `linked` to the mirror socket, and returns { mirrorId, deviceToken }.
 */
async function pairSession(sid, shortCode, accountId, phonePublicKey) {
  const session = pairingSessions.get(sid);
  if (!session) {
    const err = new Error('Pairing session not found or expired');
    err.status = 404;
    throw err;
  }
  if (Date.now() > session.expiresAt) {
    pairingSessions.delete(sid);
    const err = new Error('Pairing session expired');
    err.status = 410;
    throw err;
  }
  if (session.shortCode !== shortCode) {
    const err = new Error('Invalid pairing code');
    err.status = 403;
    throw err;
  }

  const deviceToken  = randomUUID();
  const mirrorId     = session.mirrorPublicKey;
  const safePubKey   = phonePublicKey || '';

  const db = await getDb();
  await db.run(
    `INSERT INTO mirrors (mirror_id, account_id, device_token, phone_public_key)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(mirror_id) DO UPDATE SET
       account_id      = excluded.account_id,
       device_token    = excluded.device_token,
       phone_public_key = excluded.phone_public_key`,
    mirrorId, accountId, deviceToken, safePubKey
  );

  // Auto-set the active mirror user to the first profile of this account's household.
  // This ensures the mirror shows the user's name as soon as pairing completes,
  // without requiring a separate "set active" step in the phone app.
  const firstProfile = await db.get(
    `SELECT p.id FROM profiles p
     JOIN accounts a ON a.household_id = p.household_id
     WHERE a.id = ?
     ORDER BY p.id LIMIT 1`,
    accountId
  );
  if (firstProfile) {
    await db.run(
      `INSERT INTO active_mirror_users (mirror_id, profile_id, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(mirror_id) DO UPDATE SET
         profile_id = excluded.profile_id,
         updated_at = CURRENT_TIMESTAMP`,
      mirrorId, firstProfile.id
    );
  }

  // Notify the mirror — it will store the device_token and transition to "ready"
  send(session.ws, {
    type:             'linked',
    device_token:     deviceToken,
    account_id:       String(accountId),
    phone_public_key: safePubKey,
  });

  // The pairing session is consumed — remove it
  pairingSessions.delete(sid);
  if (session.ws._mirror) delete session.ws._mirror.sid;

  return { mirrorId, deviceToken };
}

/**
 * Pair using only the 6-character short code displayed on the mirror screen.
 * Useful when the phone can't scan the QR (emulator, no camera permission, etc.).
 */
async function pairByCode(shortCode, accountId, phonePublicKey) {
  // Find the session that matches this short code
  let foundSid = null;
  for (const [sid, session] of pairingSessions.entries()) {
    if (session.shortCode === shortCode) {
      foundSid = sid;
      break;
    }
  }
  if (!foundSid) {
    const err = new Error('No pairing session found for that code. Check the code on the mirror and try again.');
    err.status = 404;
    throw err;
  }
  return pairSession(foundSid, shortCode, accountId, phonePublicKey);
}

module.exports = { start, pairSession, pairByCode };
