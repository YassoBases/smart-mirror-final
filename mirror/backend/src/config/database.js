const { open } = require("sqlite");
const sqlite3 = require("sqlite3");
const path = require("path");
const fs = require("fs");
const { initWardrobeSchema } = require("../../db/wardrobe");

// SMART_MIRROR_DB overrides the on-disk location (used by tests for an isolated
// DB, e.g. a temp file or ":memory:"). Defaults to the normal data dir.
const DB_PATH =
  process.env.SMART_MIRROR_DB || path.join(__dirname, "../../data/smart_mirror.db");
if (DB_PATH !== ":memory:") {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

// Module-level promise — resolved once on first require, reused everywhere
const dbPromise = open({ filename: DB_PATH, driver: sqlite3.Database }).then(
  async (db) => {
    await db.run("PRAGMA journal_mode = WAL");
    await db.run("PRAGMA foreign_keys = ON");

    await db.exec(`
    CREATE TABLE IF NOT EXISTS households (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id  INTEGER NOT NULL,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      household_id  INTEGER NOT NULL,
      name          TEXT    NOT NULL,
      email         TEXT,
      google_sub    TEXT,
      mirror_id     TEXT,
      face_filename TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS gmail_connections (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id    INTEGER NOT NULL UNIQUE,
      access_token  TEXT    NOT NULL,
      refresh_token TEXT    NOT NULL,
      expiry_date   DATETIME NOT NULL,
      connected_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS active_mirror_users (
      mirror_id  TEXT    PRIMARY KEY,
      profile_id INTEGER NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS spotify_connections (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id        INTEGER NOT NULL UNIQUE,
      access_token      TEXT    NOT NULL,
      refresh_token     TEXT    NOT NULL,
      expires_at        DATETIME NOT NULL,
      spotify_user_id   TEXT    NOT NULL,
      display_name      TEXT,
      connected_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mirrors (
      mirror_id        TEXT    PRIMARY KEY,
      account_id       INTEGER NOT NULL,
      device_token     TEXT    UNIQUE,
      phone_public_key TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  `);

    // Migrations for existing databases
    // These force existing databases to add the new columns without wiping the data.
    await db
      .run(`ALTER TABLE profiles ADD COLUMN mirror_id TEXT`)
      .catch(() => {});
    await db
      .run(`ALTER TABLE profiles ADD COLUMN face_filename TEXT`)
      .catch(() => {});
    // Add the new JSON config column
    await db
      .run(`ALTER TABLE profiles ADD COLUMN widgets_config TEXT`)
      .catch(() => {});
    // Multi-pose face enrollment: JSON array of filenames
    await db
      .run(`ALTER TABLE profiles ADD COLUMN face_filenames TEXT`)
      .catch(() => {});
    // Per-profile AI assistant settings (whole AiSettings block as JSON)
    await db
      .run(`ALTER TABLE profiles ADD COLUMN ai_settings TEXT`)
      .catch(() => {});

    // AI assistant settings (household-scoped)
    await db.exec(`
      CREATE TABLE IF NOT EXISTS mirror_ai_settings (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        household_id INTEGER NOT NULL UNIQUE,
        settings     TEXT    NOT NULL DEFAULT '{}',
        updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
      );
    `);

    // FCM device tokens — one row per phone; household-scoped for push fan-out
    await db.exec(`
      CREATE TABLE IF NOT EXISTS device_tokens (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        household_id INTEGER NOT NULL,
        profile_id   INTEGER,
        token        TEXT    NOT NULL UNIQUE,
        platform     TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
      );
    `);

    // Security alerts — stored so missed push notifications are still viewable
    await db.exec(`
      CREATE TABLE IF NOT EXISTS security_alerts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        household_id  INTEGER NOT NULL,
        mirror_id     TEXT    NOT NULL,
        alert_type    TEXT    NOT NULL DEFAULT 'UNKNOWN_FACE_DETECTED',
        confidence    REAL,
        image_path    TEXT,
        created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (household_id) REFERENCES households(id) ON DELETE CASCADE
      );
    `);

    // Wardrobe feature tables (items, feedback, render cache, pref-model meta)
    // + profiles.body_photo_filename. Self-contained and idempotent.
    await initWardrobeSchema(db);

    // Generic app settings (integration keys set from the mirror Settings UI,
    // e.g. the Replicate API token). Values are read at request time.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    return db;
  },
);

// All services call: const db = await getDb();
function getDb() {
  return dbPromise;
}

module.exports = { getDb };
