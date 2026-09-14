#!/usr/bin/env node
// One-off: enroll pre-existing wardrobe items into the garment-identity
// recognition gallery (garment_embeddings).
//
// Why: enrollRecognizedGarment (backend/src/controllers/wardrobeController.js)
// is the only code path that writes garment_embeddings, and it only runs when
// a garment is auto-enrolled via the mirror's "is this known?" flow. Any item
// added before that feature existed — or added the normal manual way since —
// has no embedding row, so the mirror currently reports it as unknown even
// though the user already owns it. This fixes that once, for the items that
// already exist; it does not change how new items get enrolled going forward.
//
// For each non-deleted item that has a stored nobg.png but no
// garment_embeddings row: reads that file, calls the same identity-embedding
// client enrollRecognizedGarment calls (services/wardrobe_attr POST /embed),
// and writes it via wardrobeDb.upsertGarmentEmbedding — the exact same
// insertion enrollRecognizedGarment uses, not a parallel one.
//
// Usage (from mirror/backend):
//   node scripts/backfill_garment_embeddings.js            # all profiles
//   node scripts/backfill_garment_embeddings.js --dry-run  # report only
//   node scripts/backfill_garment_embeddings.js --profile 3
//
// Idempotent: re-running only finds items still missing a row (a LEFT JOIN
// against garment_embeddings, not an INSERT OR IGNORE), so an item already
// backfilled is never re-embedded or duplicated.
//
// Reads the same .env the server uses, so set WARDROBE_ATTR_ENDPOINT_URL
// (and start services/wardrobe_attr) first.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs = require("fs");
const path = require("path");

const { getDb } = require("../src/config/database");
const wardrobeDb = require("../db/wardrobe");
const identityClient = require("../lib/wardrobe_identity_client");

function parseArgs(argv) {
  const args = { dryRun: false, profile: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--profile") args.profile = Number(argv[++i]);
  }
  return args;
}

/**
 * Core logic, exported so it can be exercised directly (tests, or a future
 * caller) without going through the CLI's process.exit. Idempotent: a second
 * call finds nothing left to do once every eligible item has a row, since
 * eligibility is "no garment_embeddings row yet", not a flag this flips.
 * @returns {{ backfilled:number, alreadyHadEmbedding:number, skippedNoFile:number, failed:number, total:number }}
 */
async function backfillMissingEmbeddings(db, { profile = null, dryRun = false, log = () => {} } = {}) {
  const alreadyRow = await db.get("SELECT COUNT(*) AS n FROM garment_embeddings");
  const alreadyHadEmbedding = alreadyRow.n;

  // Items with a stored (background-removed) photo but no gallery row yet —
  // the same LEFT JOIN shape listGarmentEmbeddings uses, inverted.
  let sql = `
    SELECT wi.* FROM wardrobe_items wi
    LEFT JOIN garment_embeddings ge ON ge.item_id = wi.id
    WHERE wi.deleted = 0 AND wi.nobg_filename IS NOT NULL AND ge.item_id IS NULL
  `;
  const params = [];
  if (profile != null && !Number.isNaN(profile)) {
    sql += " AND wi.profile_id = ?";
    params.push(profile);
  }
  sql += " ORDER BY wi.profile_id, wi.id";
  const rows = await db.all(sql, ...params);

  log(
    `Found ${rows.length} item(s) missing a recognition embedding${dryRun ? " (DRY RUN)" : ""}. ` +
      `${alreadyHadEmbedding} item(s) already had one.\n`,
  );

  const summary = { backfilled: 0, alreadyHadEmbedding, skippedNoFile: 0, failed: 0, total: rows.length };

  for (const row of rows) {
    const nobgPath = path.join(wardrobeDb.itemDir(row.profile_id, row.id), row.nobg_filename);
    if (!fs.existsSync(nobgPath)) {
      log(`  • item ${row.id} (profile ${row.profile_id}): ${row.nobg_filename} missing on disk — skipped`);
      summary.skippedNoFile += 1;
      continue;
    }
    try {
      const buffer = fs.readFileSync(nobgPath);
      const { embedding, projected } = await identityClient.getEmbedding(buffer);
      log(
        `  • item ${row.id} (profile ${row.profile_id}): embedded` +
          (projected ? " (projected)" : " (raw CLIP — no identity head trained yet)"),
      );
      if (!dryRun) {
        // Same insertion enrollRecognizedGarment uses — not a parallel path.
        await wardrobeDb.upsertGarmentEmbedding(db, row.id, row.profile_id, embedding, projected);
      }
      summary.backfilled += 1;
    } catch (err) {
      log(`  • item ${row.id} (profile ${row.profile_id}): failed — ${err.message}`);
      summary.failed += 1;
    }
  }

  return summary;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!identityClient.isConfigured()) {
    console.error(
      "✗ WARDROBE_ATTR_ENDPOINT_URL is not set. Configure it in mirror/backend/.env " +
        "and make sure services/wardrobe_attr is running before running this.",
    );
    process.exit(1);
  }

  const db = await getDb();
  const summary = await backfillMissingEmbeddings(db, {
    profile: args.profile, dryRun: args.dryRun, log: console.log,
  });

  console.log(
    `\nDone. backfilled: ${summary.backfilled}, already had an embedding: ${summary.alreadyHadEmbedding}, ` +
      `skipped (no photo file): ${summary.skippedNoFile}, failed: ${summary.failed}` +
      (args.dryRun ? "  (DRY RUN — nothing written)" : ""),
  );
  process.exit(summary.failed > 0 ? 1 : 0);
}

module.exports = { backfillMissingEmbeddings };

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
