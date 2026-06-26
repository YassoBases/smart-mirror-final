// Household shared settings for the phone app (JWT). Reads/writes the same
// app_settings store the mirror's /api/mirrors/integrations endpoint uses, so a
// change on either side is the single source of truth. Secrets are masked on
// read (the app never needs the raw key — the backend stylist resolves it
// server-side); only non-empty secrets overwrite stored values on write.
const router = require("express").Router();
const { authenticate } = require("../middleware/auth");
const { getSharedSettings, setSharedSettings } = require("../services/settingsService");

router.get("/", authenticate, async (_req, res, next) => {
  try {
    res.json({ settings: await getSharedSettings() });
  } catch (err) {
    next(err);
  }
});

router.put("/", authenticate, async (req, res, next) => {
  try {
    const patch = req.body && req.body.settings ? req.body.settings : req.body || {};
    const settings = await setSharedSettings(patch);
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
