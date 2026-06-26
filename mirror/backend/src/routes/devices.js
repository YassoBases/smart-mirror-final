const router = require('express').Router();
const { getDb } = require('../config/database');
const { authenticate } = require('../middleware/auth');

// POST /api/devices/token — upsert an FCM token for the authenticated account's household
router.post('/token', authenticate, async (req, res, next) => {
  try {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const db = await getDb();
    await db.run(
      `INSERT INTO device_tokens (household_id, token, platform)
       VALUES (?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET
         household_id = excluded.household_id,
         platform     = excluded.platform,
         created_at   = CURRENT_TIMESTAMP`,
      req.account.householdId,
      token,
      platform || null,
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/devices/token — remove an FCM token on logout
router.delete('/token', authenticate, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token is required' });

    const db = await getDb();
    await db.run(
      'DELETE FROM device_tokens WHERE token = ? AND household_id = ?',
      token,
      req.account.householdId,
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
