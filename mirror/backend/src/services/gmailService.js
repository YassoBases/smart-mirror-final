const { google } = require('googleapis');
const { getDb } = require('../config/database');

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(profileId) {
  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state: String(profileId),
  });
}

async function handleCallback(code, profileId) {
  const db = await getDb();

  const profile = await db.get('SELECT * FROM profiles WHERE id = ?', profileId);
  if (!profile) {
    throw Object.assign(new Error('Profile not found'), { status: 404 });
  }

  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.refresh_token) {
    throw Object.assign(
      new Error('No refresh token returned. Revoke app access in your Google account and try again.'),
      { status: 400 }
    );
  }

  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
  const { data: googleUser } = await oauth2.userinfo.get();

  await db.run(
    `INSERT INTO gmail_connections (profile_id, access_token, refresh_token, expiry_date)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       access_token  = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expiry_date   = excluded.expiry_date,
       connected_at  = CURRENT_TIMESTAMP`,
    profileId,
    tokens.access_token,
    tokens.refresh_token,
    new Date(tokens.expiry_date).toISOString()
  );

  await db.run(
    'UPDATE profiles SET google_sub = ?, email = ? WHERE id = ?',
    googleUser.id, googleUser.email, profileId
  );

  return { email: googleUser.email };
}

async function getAuthenticatedClient(profileId) {
  const db = await getDb();

  const connection = await db.get(
    'SELECT * FROM gmail_connections WHERE profile_id = ?',
    profileId
  );

  if (!connection) {
    throw Object.assign(new Error('No Gmail connection for this profile'), { status: 404 });
  }

  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials({
    access_token:  connection.access_token,
    refresh_token: connection.refresh_token,
    expiry_date:   new Date(connection.expiry_date).getTime(),
  });

  // Persist refreshed access tokens automatically
  oauth2Client.on('tokens', async (newTokens) => {
    if (newTokens.access_token) {
      const db2 = await getDb();
      await db2.run(
        'UPDATE gmail_connections SET access_token = ?, expiry_date = ? WHERE profile_id = ?',
        newTokens.access_token,
        new Date(newTokens.expiry_date).toISOString(),
        profileId
      );
    }
  });

  return oauth2Client;
}

async function getInboxSummary(profileId) {
  const auth = await getAuthenticatedClient(profileId);
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread in:inbox',
    maxResults: 10,
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) return [];

  const details = await Promise.all(
    messages.map((msg) =>
      gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From'],
      })
    )
  );

  return details.map((res) => {
    const headers = res.data.payload.headers;
    const get = (name) => headers.find((h) => h.name === name)?.value ?? '';
    return {
      id:      res.data.id,
      subject: get('Subject'),
      from:    get('From'),
      snippet: res.data.snippet,
    };
  });
}

async function disconnectGmail(profileId) {
  const db = await getDb();

  const connection = await db.get(
    'SELECT * FROM gmail_connections WHERE profile_id = ?',
    profileId
  );

  if (!connection) {
    throw Object.assign(new Error('No Gmail connection for this profile'), { status: 404 });
  }

  const oauth2Client = createOAuthClient();
  oauth2Client.revokeToken(connection.access_token).catch(() => {});

  await db.run('DELETE FROM gmail_connections WHERE profile_id = ?', profileId);
  await db.run('UPDATE profiles SET google_sub = NULL WHERE id = ?', profileId);
}

module.exports = { getAuthUrl, handleCallback, getInboxSummary, disconnectGmail };
