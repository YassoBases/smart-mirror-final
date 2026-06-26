/**
 * Seeds a demo profile's closet from tools/demo_assets/manifest.json (32 items).
 *
 *   node tools/seed_demo_wardrobe.js
 *
 * Idempotent: reuses the "Demo" profile (creating the household/account/profile
 * if needed), clears its existing wardrobe, then re-seeds. The profile is linked
 * to mirror id "demo-mirror" so the widget and dashboard can resolve it.
 *
 * Images: drop CC-licensed JPGs into tools/demo_assets/images/ matching the
 * manifest `file` names. Any missing image is synthesized as a solid color
 * swatch from `primaryColor`, so the demo works out-of-the-box.
 *
 * Runs the real upload pipeline (wardrobeImageService) for resize/thumb; the
 * bg-removal and BLIP-2 steps fall back automatically because their env vars are
 * intentionally left unset here (no network, fast).
 */
const fs = require("fs");
const path = require("path");

// Keep the sidecar/AI calls in fast fallback for seeding.
delete process.env.BG_REMOVER_URL;
delete process.env.BLIP2_ENDPOINT_URL;

const ROOT = path.join(__dirname, "..");
const sharp = require(path.join(ROOT, "backend", "node_modules", "sharp"));
const { getDb } = require(path.join(ROOT, "backend", "src", "config", "database"));
const wardrobeDb = require(path.join(ROOT, "backend", "db", "wardrobe"));
const imageService = require(path.join(ROOT, "backend", "src", "services", "wardrobeImageService"));

const DEMO_MIRROR_ID = "demo-mirror";
const MANIFEST = path.join(__dirname, "demo_assets", "manifest.json");

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return { r: 128, g: 128, b: 128 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

async function swatch(primaryColor) {
  return sharp({
    create: { width: 600, height: 800, channels: 3, background: hexToRgb(primaryColor) },
  })
    .jpeg()
    .toBuffer();
}

async function ensureDemoProfile(db) {
  let profile = await db.get("SELECT * FROM profiles WHERE mirror_id = ?", DEMO_MIRROR_ID);
  if (profile) return profile;

  let hh = await db.get("SELECT id FROM households WHERE name = ?", "Demo Household");
  if (!hh) {
    const r = await db.run("INSERT INTO households (name) VALUES (?)", "Demo Household");
    hh = { id: r.lastID };
    await db.run(
      "INSERT INTO accounts (household_id, email, password_hash) VALUES (?, ?, ?)",
      hh.id,
      "demo@smartmirror.local",
      "x",
    );
  }
  const p = await db.run(
    "INSERT INTO profiles (household_id, name, mirror_id) VALUES (?, ?, ?)",
    hh.id,
    "Demo",
    DEMO_MIRROR_ID,
  );
  await db.run(
    `INSERT INTO active_mirror_users (mirror_id, profile_id) VALUES (?, ?)
     ON CONFLICT(mirror_id) DO UPDATE SET profile_id = excluded.profile_id`,
    DEMO_MIRROR_ID,
    p.lastID,
  );
  return db.get("SELECT * FROM profiles WHERE id = ?", p.lastID);
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const db = await getDb();
  const profile = await ensureDemoProfile(db);
  console.log(`Demo profile id=${profile.id} (mirror "${DEMO_MIRROR_ID}")`);

  // Clear any previous demo wardrobe (hard delete + files) for a clean reseed.
  await db.run("DELETE FROM wardrobe_items WHERE profile_id = ?", profile.id);
  fs.rmSync(path.join(wardrobeDb.WARDROBE_DATA_DIR, String(profile.id)), {
    recursive: true,
    force: true,
  });

  let placeholders = 0;
  for (const item of manifest) {
    const imgPath = path.join(__dirname, "demo_assets", item.file);
    const buffer = fs.existsSync(imgPath) ? fs.readFileSync(imgPath) : await swatch(item.primaryColor);
    if (!fs.existsSync(imgPath)) placeholders += 1;

    const itemId = await wardrobeDb.createItemRow(db, profile.id);
    const { files } = await imageService.processItemUpload(buffer, profile.id, itemId);
    await wardrobeDb.updateItem(
      db,
      itemId,
      {
        category: item.category,
        subcategory: item.subcategory,
        primaryColor: item.primaryColor,
        secondaryColors: item.secondaryColors,
        pattern: item.pattern,
        fabricGuess: item.fabricGuess,
        formality: item.formality,
        warmth: item.warmth,
        seasons: item.seasons,
        tags: item.tags,
      },
      files,
    );
  }

  console.log(`Seeded ${manifest.length} items (${placeholders} synthesized swatches).`);
  console.log("Next: node tools/synthetic_feedback.js");
  process.exit(0);
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
