// Resolves which profile a wardrobe request operates on, in two modes:
//
//   requireProfileJwt  — for the Flutter routes. Runs AFTER `authenticate`;
//                        loads profiles/:profileId and enforces the household
//                        guard (403 unless it belongs to req.account.household).
//   requireProfileMid  — for the mirror widget routes (no JWT). Resolves the
//                        active profile for ?mid=<mirrorId> using the same
//                        active-user mechanism the mirror UI already polls.
//
// Both set req.wardrobeProfileId (a number) for the shared controllers.

const { getDb } = require("../config/database");
const profileService = require("../services/profileService");

async function requireProfileJwt(req, res, next) {
  try {
    const profileId = Number(req.params.profileId);
    if (!Number.isInteger(profileId)) {
      return res.status(400).json({ error: "Invalid profileId" });
    }
    const profile = await profileService.getProfile(profileId); // throws 404
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    req.wardrobeProfileId = profile.id;
    next();
  } catch (err) {
    next(err);
  }
}

// Mirror-scoped resolution: active_mirror_users first (explicit selection on the
// mirror), then the profiles.mirror_id fallback — identical to getActiveProfile
// in routes/mirrors.js, scoped down to just the id we need.
async function resolveActiveProfileId(mirrorId) {
  const db = await getDb();
  const fromActive = await db.get(
    "SELECT profile_id AS id FROM active_mirror_users WHERE mirror_id = ?",
    mirrorId,
  );
  if (fromActive) return fromActive.id;
  const fromLink = await db.get(
    "SELECT id FROM profiles WHERE mirror_id = ? ORDER BY name LIMIT 1",
    mirrorId,
  );
  return fromLink ? fromLink.id : null;
}

async function requireProfileMid(req, res, next) {
  try {
    const mirrorId = req.query.mid || req.body?.mid;
    if (!mirrorId) {
      return res.status(400).json({ error: "mid is required" });
    }
    const profileId = await resolveActiveProfileId(mirrorId);
    if (!profileId) {
      return res
        .status(404)
        .json({ error: "No active profile on this mirror" });
    }
    req.wardrobeProfileId = profileId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireProfileJwt, requireProfileMid, resolveActiveProfileId };
