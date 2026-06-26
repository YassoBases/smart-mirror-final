// Wardrobe data-access module.
//
// Owns the wardrobe SQLite tables (created idempotently from initWardrobeSchema,
// invoked by config/database.js during the shared dbPromise init) and the typed
// CRUD helpers every wardrobe route uses. Conventions match the rest of the
// backend: snake_case columns, JSON stored as TEXT, integer booleans, timestamps
// as DATETIME DEFAULT CURRENT_TIMESTAMP, FKs ON DELETE CASCADE.
//
// Files live on disk under backend/data/wardrobe/<profileId>/... and are served
// statically at /wardrobe (mirroring how faces are stored and served). The DB
// stores filenames only; full URLs are built from the request host at response
// time by serializeItem().

const path = require("path");
const fs = require("fs");

// backend/data/wardrobe — same data root the faces uploads use (backend/data).
// WARDROBE_DATA_DIR env overrides the location (tests point it at a temp dir).
const WARDROBE_DATA_DIR =
  process.env.WARDROBE_DATA_DIR || path.join(__dirname, "../data/wardrobe");

// ── Schema ──────────────────────────────────────────────────────────────────

/**
 * Creates the wardrobe tables and the profiles.body_photo_filename column.
 * Idempotent: safe on a fresh DB and on an existing one. Called once from the
 * shared dbPromise init in config/database.js.
 * @param {import('sqlite').Database} db
 */
async function initWardrobeSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS wardrobe_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id       INTEGER NOT NULL,
      image_filename   TEXT,
      thumb_filename   TEXT,
      nobg_filename    TEXT,
      category         TEXT,
      subcategory      TEXT,
      primary_color    TEXT,
      secondary_colors TEXT,            -- JSON array
      pattern          TEXT,
      fabric_guess     TEXT,
      formality        INTEGER,         -- 1..5
      warmth           INTEGER,         -- 1..5
      seasons          TEXT,            -- JSON array
      tags             TEXT,            -- JSON array
      last_worn_at     DATETIME,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted          INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS outfit_feedback (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id     INTEGER NOT NULL,
      item_ids       TEXT NOT NULL,     -- JSON array of ints
      context        TEXT,              -- JSON object
      rating         TEXT NOT NULL,     -- 'up' | 'down'
      reasoning_shown TEXT,
      synthetic      INTEGER NOT NULL DEFAULT 0,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS render_cache (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id       INTEGER NOT NULL,
      item_ids_key     TEXT NOT NULL,   -- sorted item ids joined by '-'
      body_photo_hash  TEXT NOT NULL,
      render_filename  TEXT NOT NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    -- Tracks when each profile's preference model was first/last trained, so the
    -- metrics route can report modelTrainedAt without calling the sidecar.
    CREATE TABLE IF NOT EXISTS wardrobe_pref_models (
      profile_id       INTEGER PRIMARY KEY,
      first_trained_at DATETIME,
      last_trained_at  DATETIME,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_wardrobe_items_profile ON wardrobe_items(profile_id, deleted);
    CREATE INDEX IF NOT EXISTS idx_outfit_feedback_profile ON outfit_feedback(profile_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_render_cache_key
      ON render_cache(profile_id, item_ids_key, body_photo_hash);
  `);

  // body photo lives on the profile (one per profile). Idempotent add, exactly
  // like the existing face_filename / widgets_config migrations.
  await db
    .run(`ALTER TABLE profiles ADD COLUMN body_photo_filename TEXT`)
    .catch(() => {});

  // Feedback on GENERATED outfits has no closet item ids, so store a JSON
  // snapshot of the generated items' attributes for training. Idempotent add.
  await db
    .run(`ALTER TABLE outfit_feedback ADD COLUMN items_snapshot TEXT`)
    .catch(() => {});
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function itemDir(profileId, itemId) {
  return path.join(WARDROBE_DATA_DIR, String(profileId), String(itemId));
}
function bodyDir(profileId) {
  return path.join(WARDROBE_DATA_DIR, String(profileId), "body");
}
function rendersDir(profileId) {
  return path.join(WARDROBE_DATA_DIR, String(profileId), "renders");
}
function generatedDir(profileId) {
  return path.join(WARDROBE_DATA_DIR, String(profileId), "generated");
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── JSON column helpers ───────────────────────────────────────────────────────

function parseJsonArray(text) {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function parseJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Serialization (row → API shape) ───────────────────────────────────────────

/**
 * Builds the API item shape from a DB row. URLs are derived from serverRoot
 * (e.g. "http://192.168.1.6:3000") + the static /wardrobe mount, the same way
 * faceUrl is built from the request host.
 */
function serializeItem(row, serverRoot) {
  if (!row) return null;
  const base = `${serverRoot}/wardrobe/${row.profile_id}/${row.id}`;
  return {
    id: row.id,
    profileId: row.profile_id,
    imageUrl: row.nobg_filename ? `${base}/${row.nobg_filename}` : null,
    thumbnailUrl: row.thumb_filename ? `${base}/${row.thumb_filename}` : null,
    category: row.category,
    subcategory: row.subcategory,
    primaryColor: row.primary_color,
    secondaryColors: parseJsonArray(row.secondary_colors),
    pattern: row.pattern,
    fabricGuess: row.fabric_guess,
    formality: row.formality,
    warmth: row.warmth,
    seasons: parseJsonArray(row.seasons),
    tags: parseJsonArray(row.tags),
    lastWornAt: row.last_worn_at,
    createdAt: row.created_at,
  };
}

// ── Items CRUD ────────────────────────────────────────────────────────────────

/**
 * Inserts an empty item row to obtain its auto-increment id, so the image
 * pipeline can write files under <profileId>/<itemId>/ before filling in
 * filenames + attributes via updateItem.
 */
async function createItemRow(db, profileId) {
  const result = await db.run(
    "INSERT INTO wardrobe_items (profile_id) VALUES (?)",
    profileId,
  );
  return result.lastID;
}

async function getItem(db, itemId) {
  return db.get(
    "SELECT * FROM wardrobe_items WHERE id = ? AND deleted = 0",
    itemId,
  );
}

async function listItems(db, profileId, { category, season } = {}) {
  let sql = "SELECT * FROM wardrobe_items WHERE profile_id = ? AND deleted = 0";
  const params = [profileId];
  if (category) {
    sql += " AND category = ?";
    params.push(category);
  }
  // seasons is a JSON TEXT array — match on the quoted token to avoid substring
  // collisions (e.g. "spring" inside another word).
  if (season) {
    sql += " AND seasons LIKE ?";
    params.push(`%"${season}"%`);
  }
  sql += " ORDER BY created_at DESC, id DESC";
  return db.all(sql, ...params);
}

const ATTR_COLUMNS = {
  category: "category",
  subcategory: "subcategory",
  primaryColor: "primary_color",
  secondaryColors: "secondary_colors",
  pattern: "pattern",
  fabricGuess: "fabric_guess",
  formality: "formality",
  warmth: "warmth",
  seasons: "seasons",
  tags: "tags",
  lastWornAt: "last_worn_at",
};
const JSON_ATTRS = new Set(["secondaryColors", "seasons", "tags"]);

/**
 * Updates editable attributes and/or file columns on an item.
 * `attrs` uses camelCase API keys; file columns are passed via `files`.
 */
async function updateItem(db, itemId, attrs = {}, files = {}) {
  const sets = [];
  const params = [];

  for (const [key, col] of Object.entries(ATTR_COLUMNS)) {
    if (attrs[key] === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(JSON_ATTRS.has(key) ? JSON.stringify(attrs[key]) : attrs[key]);
  }
  for (const [col, val] of Object.entries(files)) {
    if (val === undefined) continue;
    sets.push(`${col} = ?`);
    params.push(val);
  }
  if (sets.length > 0) {
    params.push(itemId);
    await db.run(
      `UPDATE wardrobe_items SET ${sets.join(", ")} WHERE id = ?`,
      ...params,
    );
  }
  return getItem(db, itemId);
}

async function softDeleteItem(db, itemId) {
  await db.run("UPDATE wardrobe_items SET deleted = 1 WHERE id = ?", itemId);
}

// ── Body photo (one per profile) ──────────────────────────────────────────────

async function setBodyPhoto(db, profileId, filename) {
  await db.run(
    "UPDATE profiles SET body_photo_filename = ? WHERE id = ?",
    filename,
    profileId,
  );
}

async function getBodyPhotoFilename(db, profileId) {
  const row = await db.get(
    "SELECT body_photo_filename FROM profiles WHERE id = ?",
    profileId,
  );
  return row ? row.body_photo_filename : null;
}

// ── Feedback ──────────────────────────────────────────────────────────────────

async function insertFeedback(
  db,
  profileId,
  { itemIds, context, rating, reasoningShown, synthetic = 0, itemsSnapshot = null },
) {
  const result = await db.run(
    `INSERT INTO outfit_feedback (profile_id, item_ids, context, rating, reasoning_shown, synthetic, items_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    profileId,
    JSON.stringify(itemIds || []),
    context ? JSON.stringify(context) : null,
    rating,
    reasoningShown ?? null,
    synthetic ? 1 : 0,
    itemsSnapshot ? JSON.stringify(itemsSnapshot) : null,
  );
  return result.lastID;
}

async function listFeedback(db, profileId, { limit = 50, offset = 0 } = {}) {
  const rows = await db.all(
    `SELECT * FROM outfit_feedback WHERE profile_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    profileId,
    limit,
    offset,
  );
  return rows.map((r) => ({
    id: r.id,
    profileId: r.profile_id,
    itemIds: parseJsonArray(r.item_ids),
    context: parseJsonObject(r.context),
    rating: r.rating,
    reasoningShown: r.reasoning_shown,
    synthetic: !!r.synthetic,
    itemsSnapshot: parseJsonArray(r.items_snapshot),
    createdAt: r.created_at,
  }));
}

async function countFeedback(db, profileId) {
  const row = await db.get(
    "SELECT COUNT(*) AS n FROM outfit_feedback WHERE profile_id = ?",
    profileId,
  );
  return row ? row.n : 0;
}

/** Raw feedback rows for the metrics buckets (all, oldest→newest). */
async function allFeedbackForMetrics(db, profileId) {
  return db.all(
    `SELECT rating, created_at FROM outfit_feedback
     WHERE profile_id = ? ORDER BY created_at ASC`,
    profileId,
  );
}

// ── Render cache ──────────────────────────────────────────────────────────────

function renderKey(itemIds) {
  return [...itemIds].map(Number).sort((a, b) => a - b).join("-");
}

async function getCachedRender(db, profileId, itemIds, bodyHash) {
  return db.get(
    `SELECT * FROM render_cache
     WHERE profile_id = ? AND item_ids_key = ? AND body_photo_hash = ?`,
    profileId,
    renderKey(itemIds),
    bodyHash,
  );
}

async function insertRender(db, profileId, itemIds, bodyHash, filename) {
  await db.run(
    `INSERT OR REPLACE INTO render_cache
       (profile_id, item_ids_key, body_photo_hash, render_filename)
     VALUES (?, ?, ?, ?)`,
    profileId,
    renderKey(itemIds),
    bodyHash,
    filename,
  );
}

// ── Pref model metadata ───────────────────────────────────────────────────────

async function getPrefModel(db, profileId) {
  return db.get(
    "SELECT * FROM wardrobe_pref_models WHERE profile_id = ?",
    profileId,
  );
}

/** Records a training event; sets first_trained_at once, last_trained_at always. */
async function markPrefModelTrained(db, profileId) {
  await db.run(
    `INSERT INTO wardrobe_pref_models (profile_id, first_trained_at, last_trained_at)
       VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(profile_id) DO UPDATE SET last_trained_at = CURRENT_TIMESTAMP`,
    profileId,
  );
}

module.exports = {
  WARDROBE_DATA_DIR,
  initWardrobeSchema,
  // paths
  itemDir,
  bodyDir,
  rendersDir,
  generatedDir,
  ensureDir,
  // serialization
  serializeItem,
  parseJsonArray,
  parseJsonObject,
  // items
  createItemRow,
  getItem,
  listItems,
  updateItem,
  softDeleteItem,
  // body photo
  setBodyPhoto,
  getBodyPhotoFilename,
  // feedback
  insertFeedback,
  listFeedback,
  countFeedback,
  allFeedbackForMetrics,
  // render cache
  renderKey,
  getCachedRender,
  insertRender,
  // pref model
  getPrefModel,
  markPrefModelTrained,
};
