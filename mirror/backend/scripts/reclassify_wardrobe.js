#!/usr/bin/env node
// Re-run the BLIP-2 classifier over existing wardrobe items.
//
// Why: items uploaded while BLIP2_ENDPOINT_URL was unset got the stub fallback
// (everything "top", or "bottom" for very tall photos). Once the endpoint is
// configured again, this re-captions each stored garment from its nobg.png and
// updates the DB — but ONLY when the endpoint actually responds, so it never
// re-writes stub values on top of good data.
//
// Usage (from mirror/backend):
//   node scripts/reclassify_wardrobe.js            # all items, all profiles
//   node scripts/reclassify_wardrobe.js --dry-run  # show what would change
//   node scripts/reclassify_wardrobe.js --profile 1
//   node scripts/reclassify_wardrobe.js --only-stub  # only items still top/bottom
//
// Reads the same .env the server uses, so set BLIP2_ENDPOINT_URL/TOKEN first.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const { getDb } = require("../src/config/database");
const wardrobeDb = require("../db/wardrobe");
const blip2 = require("../lib/blip2_client");
const aiVision = require("../lib/openai");

function parseArgs(argv) {
  const args = { dryRun: false, profile: null, onlyStub: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--only-stub") args.onlyStub = true;
    else if (a === "--profile") args.profile = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!blip2.isConfigured()) {
    console.error(
      "✗ BLIP2_ENDPOINT_URL is not set. Configure it in mirror/backend/.env\n" +
        "  before running — otherwise every item would just be re-stubbed as 'top'.",
    );
    process.exit(1);
  }

  const db = await getDb();

  // Pull items directly (not via listItems) so we can optionally scope to one
  // profile and still see every non-deleted row across profiles.
  let sql = "SELECT * FROM wardrobe_items WHERE deleted = 0";
  const params = [];
  if (args.profile != null && !Number.isNaN(args.profile)) {
    sql += " AND profile_id = ?";
    params.push(args.profile);
  }
  sql += " ORDER BY profile_id, id";
  let rows = await db.all(sql, ...params);

  if (args.onlyStub) {
    rows = rows.filter((r) => r.category === "top" || r.category === "bottom");
  }

  console.log(
    `Re-classifying ${rows.length} item(s)${args.dryRun ? " (DRY RUN)" : ""}...\n`,
  );

  const summary = { updated: 0, unchanged: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    const dir = wardrobeDb.itemDir(row.profile_id, row.id);
    // Prefer the background-removed image (what the upload pipeline classifies);
    // fall back to the original if nobg is missing.
    const nobgPath = path.join(dir, row.nobg_filename || "nobg.png");
    const origPath = path.join(dir, row.image_filename || "original.jpg");
    const imgPath = fs.existsSync(nobgPath) ? nobgPath : origPath;

    if (!fs.existsSync(imgPath)) {
      console.warn(`  • item ${row.id}: image file missing on disk — skipped`);
      summary.skipped += 1;
      continue;
    }

    try {
      const buf = fs.readFileSync(imgPath);
      const meta = await sharp(buf).metadata();
      const categoryHint =
        meta.height > meta.width * 1.4 ? "bottom" : undefined;

      let { attributes, available } = await blip2.captionImage(buf, {
        categoryHint,
      });

      // Guard: if the endpoint didn't actually answer, captionImage returns the
      // stub with available=false. Never overwrite real data with a stub.
      if (!available) {
        console.warn(
          `  • item ${row.id}: endpoint unavailable for this image — skipped`,
        );
        summary.skipped += 1;
        continue;
      }

      // Second layer: OpenAI vision QC, same as the live upload pipeline (no-op
      // when no OpenAI key is configured). Best-effort — keep CLIP on failure.
      try {
        const small = await sharp(buf)
          .resize({ width: 768, height: 768, fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 80 })
          .toBuffer();
        const corrected = await aiVision.verifyItemAttributes({
          imageBase64: small.toString("base64"),
          mimeType: "image/jpeg",
          current: attributes,
        });
        if (corrected) attributes = blip2.normalizeAttributes(corrected, attributes);
      } catch (err) {
        console.warn(`  • item ${row.id}: vision verify skipped — ${err.message}`);
      }

      const changed = attributes.category !== row.category;
      const tag = changed
        ? `${row.category} → ${attributes.category}`
        : `${row.category} (unchanged)`;
      console.log(
        `  • item ${row.id} (profile ${row.profile_id}): ${tag}` +
          (attributes.subcategory ? `  [${attributes.subcategory}]` : ""),
      );

      if (!args.dryRun) {
        await wardrobeDb.updateItem(db, row.id, attributes);
      }
      if (changed) summary.updated += 1;
      else summary.unchanged += 1;
    } catch (err) {
      console.error(`  • item ${row.id}: failed — ${err.message}`);
      summary.failed += 1;
    }
  }

  console.log(
    `\nDone. category changed: ${summary.updated}, unchanged: ${summary.unchanged}, ` +
      `skipped: ${summary.skipped}, failed: ${summary.failed}` +
      (args.dryRun ? "  (DRY RUN — nothing written)" : ""),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
