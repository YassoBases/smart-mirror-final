const router = require('express').Router();
const { getDb } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const { sendToHousehold } = require('../services/pushService');

// ── GET /api/alerts ───────────────────────────────────────────────────────────
// Returns recent security alerts for the authenticated user's household.
// Query params: limit (max 100, default 50), offset (default 0)
router.get('/', authenticate, async (req, res, next) => {
  try {
    const db     = await getDb();
    const limit  = Math.min(parseInt(req.query.limit)  || 50, 100);
    const offset = Math.max(parseInt(req.query.offset) ||  0,   0);

    const rows = await db.all(
      `SELECT id, mirror_id, alert_type, confidence, image_path, created_at
       FROM security_alerts
       WHERE household_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      req.account.householdId, limit, offset,
    );

    res.json({
      alerts: rows.map(r => ({
        id:         r.id,
        mirrorId:   r.mirror_id,
        alertType:  r.alert_type,
        confidence: r.confidence,
        imageUrl:   r.image_path ? `/alert-snapshots/${r.image_path}` : null,
        timestamp:  r.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/alerts/test ─────────────────────────────────────────────────────
// Simulates an unknown-face alert — lets you test the full pipeline without
// standing in front of the mirror camera.
// Body: { mirrorId: string }
// Auth: Bearer JWT (ensures alerts only go to the right household)
router.post('/test', authenticate, async (req, res, next) => {
  try {
    const { mirrorId } = req.body;
    if (!mirrorId) return res.status(400).json({ error: 'mirrorId is required' });

    const db = await getDb();

    // Make sure the mirror belongs to this household
    const mirror = await db.get(
      `SELECT m.mirror_id
       FROM mirrors m
       JOIN accounts a ON a.id = m.account_id
       WHERE m.mirror_id = ? AND a.household_id = ?`,
      mirrorId, req.account.householdId,
    );

    if (!mirror) {
      return res.status(404).json({ error: 'Mirror not found or not paired to your account' });
    }

    const result = await db.run(
      `INSERT INTO security_alerts (household_id, mirror_id, alert_type, confidence)
       VALUES (?, ?, 'UNKNOWN_FACE_DETECTED', ?)`,
      req.account.householdId, mirrorId, 0.72,
    );
    const alertId = result.lastID;

    await sendToHousehold(req.account.householdId, {
      title: 'Security Alert (Test)',
      body:  'Test: Unknown face detected at your mirror',
      data: {
        alertId:   String(alertId),
        alertType: 'UNKNOWN_FACE_DETECTED',
        mirrorId,
        isTest:    'true',
        timestamp: new Date().toISOString(),
      },
    });

    console.log(`[alerts] Test alert #${alertId} fired for household ${req.account.householdId}`);
    res.json({ ok: true, alertId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
