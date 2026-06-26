const path = require('path');

let _adminApp = null;
let _unconfiguredWarned = false;

function _getAdmin() {
  if (_adminApp) return _adminApp;

  const keyPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  const keyB64  = process.env.FIREBASE_SERVICE_ACCOUNT_B64;

  if (!keyPath && !keyB64) {
    if (!_unconfiguredWarned) {
      console.warn(
        '[pushService] Firebase Admin not configured — push notifications disabled.\n' +
        '  Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_B64 to enable.\n' +
        '  See SECURITY_ALERTS_SETUP.md for setup instructions.'
      );
      _unconfiguredWarned = true;
    }
    return null;
  }

  const admin = require('firebase-admin');

  let serviceAccount;
  if (keyPath) {
    serviceAccount = require(path.resolve(keyPath));
  } else {
    serviceAccount = JSON.parse(Buffer.from(keyB64, 'base64').toString('utf-8'));
  }

  _adminApp = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('[pushService] Firebase Admin initialized.');
  return _adminApp;
}

/**
 * Sends a push notification to every registered device token in the given household.
 * No-ops silently when Firebase Admin is not configured (dev mode without a service account key).
 */
async function sendToHousehold(householdId, { title, body, data = {} }) {
  const app = _getAdmin();
  if (!app) return;

  const { getDb } = require('../config/database');
  const db = await getDb();
  const rows = await db.all(
    'SELECT token FROM device_tokens WHERE household_id = ?',
    householdId,
  );

  if (rows.length === 0) {
    console.log('[pushService] No registered tokens for household', householdId);
    return;
  }

  const tokens = rows.map(r => r.token);
  const admin  = require('firebase-admin');

  const response = await admin.messaging(app).sendEachForMulticast({
    tokens,
    notification: { title, body },
    data,
  });

  // Prune tokens that FCM says are no longer valid
  const stale = [];
  response.responses.forEach((r, i) => {
    if (
      !r.success &&
      r.error?.code === 'messaging/registration-token-not-registered'
    ) {
      stale.push(tokens[i]);
    }
  });

  if (stale.length > 0) {
    for (const token of stale) {
      await db.run('DELETE FROM device_tokens WHERE token = ?', token);
    }
    console.log('[pushService] Pruned', stale.length, 'stale token(s)');
  }

  console.log(
    `[pushService] Sent to ${tokens.length} device(s) — ${response.successCount} succeeded, ${response.failureCount} failed`
  );
}

module.exports = { sendToHousehold };
