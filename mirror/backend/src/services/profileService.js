const { getDb } = require("../config/database");

async function createProfile({ householdId, name, email }) {
  const db = await getDb();

  const household = await db.get(
    "SELECT id FROM households WHERE id = ?",
    householdId,
  );
  if (!household) {
    throw Object.assign(new Error("Household not found"), { status: 404 });
  }

  const defaultWidgets = JSON.stringify({
    time_calendar: true,
    weather: true,
    news: true,
    gmail: false,
    spotify: false,
    gesture: true,
  });

  const result = await db.run(
    "INSERT INTO profiles (household_id, name, email, widgets_config) VALUES (?, ?, ?, ?)",
    householdId,
    name,
    email || null,
    defaultWidgets,
  );

  return db.get("SELECT * FROM profiles WHERE id = ?", result.lastID);
}

async function listProfiles(householdId) {
  const db = await getDb();
  return db.all(
    "SELECT id, household_id, name, email, google_sub, mirror_id, face_filename, face_filenames, widgets_config, created_at FROM profiles WHERE household_id = ? ORDER BY name",
    householdId,
  );
}

async function setMirrorId(profileId, mirrorId) {
  const db = await getDb();
  await db.run(
    "UPDATE profiles SET mirror_id = ? WHERE id = ?",
    mirrorId || null,
    profileId,
  );
  return db.get("SELECT * FROM profiles WHERE id = ?", profileId);
}

async function getProfilesByMirrorId(mirrorId) {
  const db = await getDb();
  return db.all(
    `SELECT p.id, p.household_id, p.name, p.email, p.google_sub, p.mirror_id, p.face_filename, p.face_filenames, p.widgets_config, p.created_at,
            CASE WHEN gc.profile_id IS NOT NULL THEN 1 ELSE 0 END AS gmail_connected
     FROM profiles p
     LEFT JOIN gmail_connections gc ON gc.profile_id = p.id
     WHERE p.mirror_id = ?
     ORDER BY p.name`,
    mirrorId,
  );
}

async function getProfile(id) {
  const db = await getDb();
  const profile = await db.get(
    `SELECT p.*,
            CASE WHEN gc.profile_id IS NOT NULL THEN 1 ELSE 0 END AS gmail_connected,
            CASE WHEN sc.profile_id IS NOT NULL THEN 1 ELSE 0 END AS spotify_connected,
            sc.display_name AS spotify_display_name
     FROM profiles p
     LEFT JOIN gmail_connections   gc ON gc.profile_id = p.id
     LEFT JOIN spotify_connections sc ON sc.profile_id = p.id
     WHERE p.id = ?`,
    id,
  );
  if (!profile) {
    throw Object.assign(new Error("Profile not found"), { status: 404 });
  }
  return profile;
}

async function updateProfile(profileId, { name, email } = {}) {
  const db = await getDb();
  const sets = [];
  const args = [];
  if (name !== undefined) {
    sets.push("name = ?");
    args.push(String(name).trim());
  }
  if (email !== undefined) {
    sets.push("email = ?");
    args.push(email ? String(email).trim() : null);
  }
  if (sets.length) {
    args.push(profileId);
    await db.run(`UPDATE profiles SET ${sets.join(", ")} WHERE id = ?`, ...args);
  }
  return getProfile(profileId);
}

async function deleteProfile(id) {
  const db = await getDb();
  await db.run("DELETE FROM profiles WHERE id = ?", id);
}

// --- NEW FUNCTION: Update Widgets ---
async function updateWidgets(profileId, widgetsConfig) {
  const db = await getDb();
  // Stringify the JSON object to store it in SQLite
  const jsonString = JSON.stringify(widgetsConfig);

  await db.run(
    "UPDATE profiles SET widgets_config = ? WHERE id = ?",
    jsonString,
    profileId,
  );

  return getProfile(profileId); // Return the updated profile
}

async function getAiSettings(profileId) {
  const profile = await getProfile(profileId);
  return profile.ai_settings ? JSON.parse(profile.ai_settings) : {};
}

async function updateAiSettings(profileId, settings) {
  const db = await getDb();
  const profile = await getProfile(profileId);
  const current = profile.ai_settings ? JSON.parse(profile.ai_settings) : {};
  // A blank secret in a partial save must not wipe a stored one.
  const incoming = { ...settings };
  for (const k of ["apiKey", "elevenLabsKey"]) {
    if (k in incoming && (incoming[k] == null || String(incoming[k]).trim() === "")) {
      delete incoming[k];
    }
  }
  const merged = { ...current, ...incoming };
  await db.run(
    "UPDATE profiles SET ai_settings = ? WHERE id = ?",
    JSON.stringify(merged),
    profileId,
  );
  return getProfile(profileId);
}

module.exports = {
  createProfile,
  listProfiles,
  getProfile,
  setMirrorId,
  getProfilesByMirrorId,
  updateProfile,
  deleteProfile,
  updateWidgets,
  getAiSettings,
  updateAiSettings,
};
