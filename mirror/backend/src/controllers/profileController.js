const { getDb } = require("../config/database");
const profileService = require("../services/profileService");

async function setMirror(req, res, next) {
  try {
    const profile = await profileService.getProfile(Number(req.params.id));
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { mirrorId } = req.body;
    const updated = await profileService.setMirrorId(profile.id, mirrorId);
    res.json({ profile: updated });
  } catch (err) {
    next(err);
  }
}

async function getByMirrorId(req, res, next) {
  try {
    const profiles = await profileService.getProfilesByMirrorId(
      req.params.mirrorId,
    );
    res.json({ profiles });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const { name, email } = req.body;
    const householdId = req.account.householdId;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Profile name is required" });
    }

    const profile = await profileService.createProfile({
      householdId,
      name: name.trim(),
      email,
    });
    res.status(201).json({ profile });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const householdId = req.account.householdId;
    const profiles = await profileService.listProfiles(householdId);
    res.json({ profiles });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const profile = await profileService.getProfile(Number(req.params.id));

    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.json({ profile });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/profiles/:id — edit name/email.
async function update(req, res, next) {
  try {
    const profile = await profileService.getProfile(Number(req.params.id));
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const { name, email } = req.body || {};
    if (name !== undefined && (!name || !String(name).trim())) {
      return res.status(400).json({ error: "Profile name cannot be empty" });
    }
    const updated = await profileService.updateProfile(profile.id, { name, email });
    res.json({ profile: updated });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const profile = await profileService.getProfile(Number(req.params.id));
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    await profileService.deleteProfile(profile.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function uploadFace(req, res, next) {
  try {
    // 1. Verify profile exists and belongs to this user
    const profile = await profileService.getProfile(Number(req.params.id));
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // 2. Ensure the file was actually uploaded
    if (!req.file) {
      return res.status(400).json({ error: "No face image uploaded" });
    }

    console.log(
      `[Backend] Face image saved to ${req.file.path} for profile ${profile.id}`,
    );

    const db = await getDb();
    await db.run(
      "UPDATE profiles SET face_filename = ? WHERE id = ?",
      req.file.filename,
      profile.id,
    );

    // 3. Return success to the mobile app
    res.json({
      message: "Face registered successfully",
      filePath: req.file.path,
    });
  } catch (err) {
    next(err);
  }
}

async function uploadFaces(req, res, next) {
  try {
    const profile = await profileService.getProfile(Number(req.params.id));
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No face images uploaded" });
    }
    const names = req.files.map((f) => f.filename);
    const db = await getDb();
    await db.run(
      "UPDATE profiles SET face_filenames = ?, face_filename = ? WHERE id = ?",
      JSON.stringify(names),
      names[0],
      profile.id,
    );
    console.log(
      `[Backend] ${names.length} face pose(s) saved for profile ${profile.id}`,
    );
    res.json({ message: "Faces registered successfully", count: names.length });
  } catch (err) {
    next(err);
  }
}

async function updateWidgets(req, res, next) {
  try {
    const profile = await profileService.getProfile(Number(req.params.id));
    // Security check
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const { widgets } = req.body;
    const updated = await profileService.updateWidgets(profile.id, widgets);
    res.json({ profile: updated });
  } catch (err) {
    next(err);
  }
}

async function getAiSettings(req, res, next) {
  try {
    const profile = await profileService.getProfile(Number(req.params.id));
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const settings = await profileService.getAiSettings(profile.id);
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}

async function updateAiSettings(req, res, next) {
  try {
    const profile = await profileService.getProfile(Number(req.params.id));
    if (profile.household_id !== req.account.householdId) {
      return res.status(403).json({ error: "Forbidden" });
    }
    const incoming = req.body.settings || {};
    const updated = await profileService.updateAiSettings(profile.id, incoming);
    const settings = updated.ai_settings ? JSON.parse(updated.ai_settings) : {};
    res.json({ settings });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  create,
  list,
  getOne,
  update,
  setMirror,
  getByMirrorId,
  remove,
  uploadFace,
  uploadFaces,
  updateWidgets,
  getAiSettings,
  updateAiSettings,
};
