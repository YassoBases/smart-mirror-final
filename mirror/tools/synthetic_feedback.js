/**
 * Seeds plausible synthetic feedback (synthetic=1) for the demo profile so the
 * preference model has something to learn from on day one and the acceptance
 * dashboard has a real before/after story.
 *
 *   node tools/synthetic_feedback.js
 *
 * Produces ~36 rows spread over 6 weekly buckets with backdated created_at:
 * acceptance is low before the "model trained" boundary (week 3) and high after
 * — simulating suggestions improving once the ranker kicks in. Sets
 * wardrobe_pref_models.first_trained_at to that boundary. If PREF_RANKER_URL is
 * set it also trains the real model from these rows.
 */
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { getDb } = require(path.join(ROOT, "backend", "src", "config", "database"));
const wardrobeDb = require(path.join(ROOT, "backend", "db", "wardrobe"));
const prefClient = require(path.join(ROOT, "backend", "lib", "pref_client"));

const DEMO_MIRROR_ID = "demo-mirror";
const WEEKS = 6;
const PER_WEEK = 6;
const TRAIN_BOUNDARY_WEEK = 3; // rows from this week on are "after training"

function fmt(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function pick(arr, i) {
  return arr[i % arr.length];
}

async function main() {
  const db = await getDb();
  const profile = await db.get("SELECT * FROM profiles WHERE mirror_id = ?", DEMO_MIRROR_ID);
  if (!profile) {
    console.error('No demo profile. Run "node tools/seed_demo_wardrobe.js" first.');
    process.exit(1);
  }

  const rows = await db.all(
    "SELECT * FROM wardrobe_items WHERE profile_id = ? AND deleted = 0",
    profile.id,
  );
  const tops = rows.filter((r) => r.category === "top");
  const bottoms = rows.filter((r) => r.category === "bottom");
  const outer = rows.filter((r) => r.category === "outerwear");
  if (!tops.length || !bottoms.length) {
    console.error("Demo wardrobe missing tops/bottoms — reseed first.");
    process.exit(1);
  }

  // Fresh start for repeatable demos.
  await db.run("DELETE FROM outfit_feedback WHERE profile_id = ? AND synthetic = 1", profile.id);

  const now = Date.now();
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const context = { temperature: 9, weather: "Clouds", timeOfDay: "evening", season: "winter" };
  let n = 0;

  for (let w = 0; w < WEEKS; w++) {
    const after = w >= TRAIN_BOUNDARY_WEEK;
    const upRate = after ? 0.85 : 0.4; // acceptance jumps once the model is trained
    for (let k = 0; k < PER_WEEK; k++) {
      const top = pick(tops, n);
      const bottom = pick(bottoms, n + 1);
      const itemIds = [top.id, bottom.id];
      if (n % 3 === 0 && outer.length) itemIds.push(pick(outer, n).id);
      const rating = (k / PER_WEEK) < upRate ? "up" : "down";

      // Backdate within the week (oldest week first).
      const created = new Date(now - (WEEKS - 1 - w) * weekMs - k * 3600 * 1000);
      await db.run(
        `INSERT INTO outfit_feedback (profile_id, item_ids, context, rating, reasoning_shown, synthetic, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        profile.id,
        JSON.stringify(itemIds),
        JSON.stringify(context),
        rating,
        "Seasonal pairing for a cool winter evening.",
        fmt(created),
      );
      n += 1;
    }
  }

  // Stamp the training boundary so metrics can split before/after.
  const trainedAt = fmt(new Date(now - (WEEKS - TRAIN_BOUNDARY_WEEK) * weekMs));
  await db.run(
    `INSERT INTO wardrobe_pref_models (profile_id, first_trained_at, last_trained_at)
     VALUES (?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET last_trained_at = excluded.last_trained_at`,
    profile.id,
    trainedAt,
    fmt(new Date(now)),
  );
  console.log(`Inserted ${n} synthetic feedback rows; model trained at ${trainedAt}.`);

  // Optionally train the real model from these rows.
  if (prefClient.isConfigured()) {
    const metaById = new Map(rows.map((r) => [r.id, {
      id: r.id, category: r.category, subcategory: r.subcategory,
      primaryColor: r.primary_color, secondaryColors: wardrobeDb.parseJsonArray(r.secondary_colors),
      pattern: r.pattern, fabricGuess: r.fabric_guess, formality: r.formality, warmth: r.warmth,
      seasons: wardrobeDb.parseJsonArray(r.seasons), tags: wardrobeDb.parseJsonArray(r.tags),
      lastWornAt: r.last_worn_at,
    }]));
    const fb = await wardrobeDb.listFeedback(db, profile.id, { limit: 1000, offset: 0 });
    const samples = fb
      .map((f) => ({
        items: (f.itemIds || []).map((id) => metaById.get(id)).filter(Boolean),
        context: f.context || {},
        label: f.rating === "up" ? 1 : 0,
      }))
      .filter((s) => s.items.length > 0);
    const ok = await prefClient.train(profile.id, samples);
    console.log(ok ? "Trained real pref model via PREF_RANKER_URL." : "pref_ranker train skipped/failed.");
  } else {
    console.log("PREF_RANKER_URL unset — skipped real training (timestamps still seeded).");
  }

  console.log("Open the dashboard: tools/acceptance_dashboard (mounted at /admin/wardrobe).");
  process.exit(0);
}

main().catch((err) => {
  console.error("synthetic_feedback failed:", err);
  process.exit(1);
});
