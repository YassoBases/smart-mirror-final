// Shared wardrobe controllers. Every handler reads req.wardrobeProfileId (set by
// requireProfileJwt or requireProfileMid) so the same code serves both the JWT
// (Flutter) routes and the mirror (?mid=) routes.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { getDb } = require("../config/database");
const wardrobeDb = require("../../db/wardrobe");
const imageService = require("../services/wardrobeImageService");
const aiClient = require("../../lib/openai");
const replicate = require("../../lib/replicate");
const prefClient = require("../../lib/pref_client");
const contextLib = require("../../lib/context");
const settings = require("./../services/settingsService");
const {
  validate,
  itemPatchSchema,
  itemListQuerySchema,
  suggestSchema,
  generateSchema,
  renderSchema,
  feedbackSchema,
  feedbackListQuerySchema,
} = require("../validation/wardrobe");

// Full server origin (e.g. http://192.168.1.6:3000) for building image URLs,
// matching how the mirror/phone already reach static /faces over the LAN.
function serverRoot(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function bodyPhotoUrl(req, profileId, filename) {
  if (!filename) return null;
  return `${serverRoot(req)}/wardrobe/${profileId}/body/${filename}`;
}

// ── Items ─────────────────────────────────────────────────────────────────────

async function createItem(req, res, next) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No image uploaded (field 'image')" });
    }
    const profileId = req.wardrobeProfileId;
    const db = await getDb();

    // Insert first to get the auto-increment id, then write files under <itemId>/.
    const itemId = await wardrobeDb.createItemRow(db, profileId);
    const { files, attributes, aiAttributesAvailable } =
      await imageService.processItemUpload(req.file.buffer, profileId, itemId);

    const row = await wardrobeDb.updateItem(db, itemId, attributes, files);
    res.status(201).json({
      item: wardrobeDb.serializeItem(row, serverRoot(req)),
      aiAttributesAvailable,
    });
  } catch (err) {
    next(err);
  }
}

async function listItems(req, res, next) {
  try {
    const filters = validate(itemListQuerySchema, req.query);
    const db = await getDb();
    const rows = await wardrobeDb.listItems(db, req.wardrobeProfileId, filters);
    res.json({ items: rows.map((r) => wardrobeDb.serializeItem(r, serverRoot(req))) });
  } catch (err) {
    next(err);
  }
}

async function patchItem(req, res, next) {
  try {
    const attrs = validate(itemPatchSchema, req.body || {});
    const db = await getDb();
    const itemId = Number(req.params.id);

    const existing = await wardrobeDb.getItem(db, itemId);
    if (!existing || existing.profile_id !== req.wardrobeProfileId) {
      return res.status(404).json({ error: "Item not found" });
    }
    const row = await wardrobeDb.updateItem(db, itemId, attrs);
    res.json({ item: wardrobeDb.serializeItem(row, serverRoot(req)) });
  } catch (err) {
    next(err);
  }
}

async function deleteItem(req, res, next) {
  try {
    const db = await getDb();
    const itemId = Number(req.params.id);
    const existing = await wardrobeDb.getItem(db, itemId);
    if (!existing || existing.profile_id !== req.wardrobeProfileId) {
      return res.status(404).json({ error: "Item not found" });
    }
    await wardrobeDb.softDeleteItem(db, itemId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// ── Body photo ────────────────────────────────────────────────────────────────

async function postBodyPhoto(req, res, next) {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: "No photo uploaded (field 'photo')" });
    }
    const profileId = req.wardrobeProfileId;
    const db = await getDb();
    const filename = await imageService.processBodyPhoto(req.file.buffer, profileId);
    await wardrobeDb.setBodyPhoto(db, profileId, filename);
    res.json({ bodyPhotoUrl: bodyPhotoUrl(req, profileId, filename) });
  } catch (err) {
    next(err);
  }
}

async function getBodyPhoto(req, res, next) {
  try {
    const profileId = req.wardrobeProfileId;
    const db = await getDb();
    const filename = await wardrobeDb.getBodyPhotoFilename(db, profileId);
    res.json({ bodyPhotoUrl: bodyPhotoUrl(req, profileId, filename) });
  } catch (err) {
    next(err);
  }
}

// ── Outfit suggestion ─────────────────────────────────────────────────────────

// Compact metadata view (no image bytes/URLs) — this is all the stylist model sees.
function itemMetadata(row) {
  return {
    id: row.id,
    category: row.category,
    subcategory: row.subcategory,
    primaryColor: row.primary_color,
    secondaryColors: wardrobeDb.parseJsonArray(row.secondary_colors),
    pattern: row.pattern,
    fabricGuess: row.fabric_guess,
    formality: row.formality,
    warmth: row.warmth,
    seasons: wardrobeDb.parseJsonArray(row.seasons),
    tags: wardrobeDb.parseJsonArray(row.tags),
    lastWornAt: row.last_worn_at,
  };
}

// Deterministic local fallback when Claude is unavailable: pair the most recent
// top with the most recent bottom, always add footwear when available, and add
// outerwear when it's cold.
function localSuggest(items, context, count) {
  const byCat = (c) => items.filter((i) => i.category === c);
  const tops = byCat("top");
  const bottoms = byCat("bottom");
  const outer = byCat("outerwear");
  const footwear = byCat("footwear");
  const candidates = [];
  const cold = typeof context.temperature === "number" && context.temperature < 12;

  for (let i = 0; i < count && i < Math.max(tops.length, 1); i++) {
    const top = tops[i % Math.max(tops.length, 1)];
    const bottom = bottoms[i % Math.max(bottoms.length, 1)];
    if (!top || !bottom) break;
    const ids = [top.id, bottom.id];
    let reasoning = `Pairs the ${top.subcategory || "top"} with the ${
      bottom.subcategory || "bottom"
    } for ${context.season} ${context.timeOfDay}.`;
    // Always finish the look with footwear when the closet has some.
    if (footwear.length) {
      const shoe = footwear[i % footwear.length];
      ids.push(shoe.id);
      reasoning += ` Finished with the ${shoe.subcategory || "footwear"}.`;
    }
    if (cold && outer[0]) {
      ids.push(outer[0].id);
      reasoning += ` Added the ${outer[0].subcategory || "outerwear"} for the cool ${
        context.temperature
      }°C weather.`;
    }
    candidates.push({ itemIds: ids, reasoning, confidence: 0.5 });
  }
  return candidates;
}

async function suggestOutfit(req, res, next) {
  try {
    const { count = 3, occasion } = validate(suggestSchema, req.body || {});
    const profileId = req.wardrobeProfileId;
    const db = await getDb();

    const rows = await wardrobeDb.listItems(db, profileId, {});
    const validIds = new Set(rows.map((r) => r.id));
    const metadata = rows.map(itemMetadata);
    // Merge the user-chosen occasion into context so it reaches the stylist
    // prompt, the preference ranker, and (echoed back) the stored feedback.
    const baseContext = await contextLib.getContext();
    const context =
        occasion && occasion !== "any" ? { ...baseContext, occasion } : baseContext;

    let candidates;
    if ((await aiClient.isConfigured()) && metadata.length > 0) {
      try {
        const out = await aiClient.suggestOutfits({ items: metadata, context, count });
        candidates = out.candidates;
      } catch (err) {
        console.warn("[wardrobe] OpenAI suggest failed, using local:", err.message);
        candidates = localSuggest(metadata, context, count);
      }
    } else {
      candidates = localSuggest(metadata, context, count);
    }

    // Drop hallucinated item ids; keep candidates that still have ≥1 valid id.
    candidates = candidates
      .map((cnd) => ({
        ...cnd,
        itemIds: (cnd.itemIds || []).filter((id) => validIds.has(id)),
      }))
      .filter((cnd) => cnd.itemIds.length > 0);

    // Re-rank by the profile's learned preference, if a model exists. The ranker
    // needs each candidate's item attributes, so enrich from the metadata map.
    const metaById = new Map(metadata.map((m) => [m.id, m]));
    const scoreInput = candidates.map((cnd) => ({
      item_ids: cnd.itemIds,
      items: cnd.itemIds.map((id) => metaById.get(id)).filter(Boolean),
    }));
    const scores = await prefClient.score(profileId, scoreInput, context);
    if (Array.isArray(scores) && scores.length === candidates.length) {
      candidates = candidates
        .map((cnd, i) => ({ cnd, s: scores[i] }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.cnd);
    }

    res.json({ candidates, context });
  } catch (err) {
    next(err);
  }
}

// ── Outfit render (VTON) ──────────────────────────────────────────────────────

// Replicate fetches the body/garment images from the open internet, so it needs
// a publicly reachable origin — PUBLIC_BASE_URL (e.g. an ngrok https URL). Falls
// back to the request host for local-only setups (where VTON won't actually run).
function publicRoot(req) {
  const pub = process.env.PUBLIC_BASE_URL;
  return pub ? pub.replace(/\/$/, "") : serverRoot(req);
}

function itemImageUrl(root, profileId, row) {
  const base = `${root}/wardrobe/${profileId}/${row.id}`;
  return row.nobg_filename ? `${base}/${row.nobg_filename}` : null;
}

async function renderOutfit(req, res, next) {
  try {
    const { itemIds } = validate(renderSchema, req.body || {});
    const profileId = req.wardrobeProfileId;
    const db = await getDb();

    const bodyFilename = await wardrobeDb.getBodyPhotoFilename(db, profileId);
    if (!bodyFilename) {
      return res.status(400).json({ error: "No body photo set for this profile" });
    }
    const bodyPath = path.join(wardrobeDb.bodyDir(profileId), bodyFilename);
    const bodyHash = crypto
      .createHash("md5")
      .update(fs.readFileSync(bodyPath))
      .digest("hex");

    // Cache hit?
    const cached = await wardrobeDb.getCachedRender(db, profileId, itemIds, bodyHash);
    if (cached) {
      return res.json({
        renderUrl: `${serverRoot(req)}/wardrobe/${profileId}/renders/${cached.render_filename}`,
        fromCache: true,
      });
    }

    // Resolve items; only top + bottom are composited (per the spec).
    const rows = [];
    for (const id of itemIds) {
      const row = await wardrobeDb.getItem(db, id);
      if (row && row.profile_id === profileId) rows.push(row);
    }
    const top = rows.find((r) => r.category === "top");
    const bottom = rows.find((r) => r.category === "bottom");
    const bodyUrl = bodyPhotoUrl(req, profileId, bodyFilename);

    // Replicate config: prefer values set in the mirror Settings UI (app_settings),
    // fall back to env. publicBase is the origin Replicate fetches images from.
    const apiToken = await settings.getSetting("replicate_api_token", process.env.REPLICATE_API_TOKEN);
    const model = await settings.getSetting("replicate_vton_model", process.env.REPLICATE_VTON_MODEL);
    const publicBase =
      (await settings.getSetting("public_base_url", process.env.PUBLIC_BASE_URL)) || publicRoot(req);

    let finalUrl = bodyUrl;
    if (apiToken || replicate.isConfigured()) {
      try {
        const pub = publicBase.replace(/\/$/, "");
        // Inputs sent to Replicate must be public; the body image starts the chain.
        let human = `${pub}/wardrobe/${profileId}/body/${bodyFilename}`;
        if (top) {
          human = await replicate.tryOn({
            humanImageUrl: human,
            garmentImageUrl: itemImageUrl(pub, profileId, top),
            garmentDes: top.subcategory || "top",
            apiToken,
            model,
          });
        }
        if (bottom) {
          human = await replicate.tryOn({
            humanImageUrl: human,
            garmentImageUrl: itemImageUrl(pub, profileId, bottom),
            garmentDes: bottom.subcategory || "bottom",
            apiToken,
            model,
          });
        }
        finalUrl = human;
      } catch (err) {
        console.warn("[wardrobe] VTON render failed, returning body photo:", err.message);
        finalUrl = bodyUrl;
      }
    }

    // Persist the render file. When VTON ran, download the output; otherwise copy
    // the body photo so the cache key still resolves to a real file.
    const dir = wardrobeDb.ensureDir(wardrobeDb.rendersDir(profileId));
    const filename = `${wardrobeDb.renderKey(itemIds)}_${bodyHash.slice(0, 8)}.jpg`;
    const dest = path.join(dir, filename);
    if (finalUrl && finalUrl !== bodyUrl) {
      const r = await fetch(finalUrl);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(dest, buf);
    } else {
      fs.copyFileSync(bodyPath, dest);
    }

    await wardrobeDb.insertRender(db, profileId, itemIds, bodyHash, filename);
    res.json({
      renderUrl: `${serverRoot(req)}/wardrobe/${profileId}/renders/${filename}`,
      fromCache: false,
    });
  } catch (err) {
    next(err);
  }
}

// ── Outfit generation (new ideas, not from the closet) ────────────────────────

// Builds a Google Shopping search URL from a free-text item description so the
// phone can open real "where to buy" results (no product API/key needed).
function shoppingSearchUrl(item) {
  const q =
    (item.description && item.description.trim()) ||
    [item.primaryColor, item.subcategory || item.category]
      .filter(Boolean)
      .join(" ");
  return `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q || "outfit")}`;
}

// Generates a preview image for one item and stores it under the profile's
// generated/ dir, cached by prompt hash. Returns the served URL, or null when
// image generation is unavailable/fails (the feature degrades to concept cards).
async function generateItemImage(req, profileId, imagePrompt, apiToken, model) {
  if (!imagePrompt) return null;
  try {
    const dir = wardrobeDb.ensureDir(wardrobeDb.generatedDir(profileId));
    const filename = `${crypto.createHash("md5").update(imagePrompt).digest("hex")}.jpg`;
    const dest = path.join(dir, filename);
    if (!fs.existsSync(dest)) {
      const url = await replicate.generateImage({
        prompt: `${imagePrompt}, product photo, plain white background, no person`,
        apiToken,
        model,
      });
      const r = await fetch(url);
      fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    }
    return `${serverRoot(req)}/wardrobe/${profileId}/generated/${filename}`;
  } catch (err) {
    console.warn("[wardrobe] generate image failed:", err.message);
    return null;
  }
}

async function generateOutfit(req, res, next) {
  try {
    const { count = 3, occasion } = validate(generateSchema, req.body || {});
    const profileId = req.wardrobeProfileId;
    const db = await getDb();

    if (!(await aiClient.isConfigured())) {
      return res
        .status(503)
        .json({ error: "Outfit generation is not configured on this server." });
    }

    const baseContext = await contextLib.getContext();
    const context =
        occasion && occasion !== "any" ? { ...baseContext, occasion } : baseContext;

    let candidates;
    try {
      const out = await aiClient.generateOutfits({ context, count });
      candidates = Array.isArray(out.candidates) ? out.candidates : [];
    } catch (err) {
      console.warn("[wardrobe] generate failed:", err.message);
      return res.status(502).json({ error: "Could not generate outfits right now." });
    }

    // Render a preview image per item and attach a shopping link. Image gen is
    // best-effort — items keep their attributes + link even if no image returns.
    const apiToken = await settings.getSetting("replicate_api_token", process.env.REPLICATE_API_TOKEN);
    const model = await settings.getSetting("replicate_txt2img_model", process.env.REPLICATE_TXT2IMG_MODEL);
    const canImage = !!apiToken || replicate.isImageGenConfigured();

    for (const cnd of candidates) {
      cnd.items = Array.isArray(cnd.items) ? cnd.items : [];
      for (const item of cnd.items) {
        item.searchUrl = shoppingSearchUrl(item);
        item.imageUrl = canImage
          ? await generateItemImage(req, profileId, item.imagePrompt, apiToken, model)
          : null;
      }
    }

    // Re-rank generated candidates by the profile's learned style (attribute-based
    // ranker — no closet ids needed).
    try {
      const scoreInput = candidates.map((cnd) => ({ item_ids: [], items: cnd.items }));
      const scores = await prefClient.score(profileId, scoreInput, context);
      if (Array.isArray(scores) && scores.length === candidates.length) {
        candidates = candidates
          .map((cnd, i) => ({ cnd, s: scores[i] }))
          .sort((a, b) => b.s - a.s)
          .map((x) => x.cnd);
      }
    } catch (err) {
      console.warn("[wardrobe] generate re-rank failed:", err.message);
    }

    res.json({ candidates, context });
  } catch (err) {
    next(err);
  }
}

// ── Feedback ──────────────────────────────────────────────────────────────────

// Train at 10, 50, 100, then every 100 feedback rows.
function crossesTrainThreshold(total) {
  return total === 10 || total === 50 || (total >= 100 && total % 100 === 0);
}

// Assembles labeled training samples (items + context + 1/0 label) from the
// profile's feedback rows, resolving item attributes — including soft-deleted
// items the feedback still references.
async function buildTrainingSamples(db, profileId) {
  const rows = await db.all(
    "SELECT * FROM wardrobe_items WHERE profile_id = ?",
    profileId,
  );
  const metaById = new Map(rows.map((r) => [r.id, itemMetadata(r)]));
  const feedback = await wardrobeDb.listFeedback(db, profileId, { limit: 1000, offset: 0 });
  return feedback
    .map((fb) => {
      // Closet feedback resolves ids → attributes; generated feedback carries the
      // item attributes directly in items_snapshot. Either feeds the ranker.
      const closetItems = (fb.itemIds || []).map((id) => metaById.get(id)).filter(Boolean);
      const items = closetItems.length > 0 ? closetItems : fb.itemsSnapshot || [];
      return {
        items,
        context: fb.context || {},
        label: fb.rating === "up" ? 1 : 0,
      };
    })
    .filter((s) => s.items.length > 0);
}

async function postFeedback(req, res, next) {
  try {
    const body = validate(feedbackSchema, req.body || {});
    const profileId = req.wardrobeProfileId;
    const db = await getDb();

    await wardrobeDb.insertFeedback(db, profileId, {
      itemIds: body.itemIds || [],
      context: body.context,
      rating: body.rating,
      reasoningShown: body.reasoningShown,
      // Generated-outfit feedback carries item attributes (no closet ids).
      itemsSnapshot: body.items && body.items.length > 0 ? body.items : null,
    });

    const total = await wardrobeDb.countFeedback(db, profileId);
    if (crossesTrainThreshold(total)) {
      // Fire-and-forget; record the training timestamp when the sidecar accepts.
      const samples = await buildTrainingSamples(db, profileId);
      prefClient
        .train(profileId, samples)
        .then((ok) => ok && wardrobeDb.markPrefModelTrained(db, profileId))
        .catch((e) => console.warn("[wardrobe] train trigger failed:", e.message));
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

async function getFeedback(req, res, next) {
  try {
    const q = validate(feedbackListQuerySchema, req.query);
    const db = await getDb();
    const feedback = await wardrobeDb.listFeedback(db, req.wardrobeProfileId, {
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });
    res.json({ feedback });
  } catch (err) {
    next(err);
  }
}

// ── Context ───────────────────────────────────────────────────────────────────

async function getContextRoute(_req, res, next) {
  try {
    res.json(await contextLib.getContext());
  } catch (err) {
    next(err);
  }
}

// ── Metrics ───────────────────────────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function getAcceptanceMetrics(req, res, next) {
  try {
    const db = await getDb();
    const profileId = req.wardrobeProfileId;
    const rows = await wardrobeDb.allFeedbackForMetrics(db, profileId);

    // Bucket into fixed 7-day windows anchored at the Unix epoch (deterministic).
    const buckets = new Map();
    for (const r of rows) {
      const t = new Date(r.created_at + "Z").getTime();
      const ms = Number.isNaN(t) ? Date.parse(r.created_at) : t;
      const weekIndex = Math.floor(ms / WEEK_MS);
      const weekStart = new Date(weekIndex * WEEK_MS).toISOString().slice(0, 10);
      if (!buckets.has(weekStart)) buckets.set(weekStart, { total: 0, accepted: 0 });
      const b = buckets.get(weekStart);
      b.total += 1;
      if (r.rating === "up") b.accepted += 1;
    }

    const out = [...buckets.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([weekStart, b]) => ({
        weekStart,
        total: b.total,
        accepted: b.accepted,
        rate: b.total ? b.accepted / b.total : 0,
      }));

    const model = await wardrobeDb.getPrefModel(db, profileId);
    let modelTrainedAt = model ? model.first_trained_at : null;
    if (!modelTrainedAt) {
      const h = await prefClient.health();
      modelTrainedAt = h && h.trained_at ? h.trained_at : null;
    }

    res.json({ buckets: out, modelTrainedAt });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  serverRoot,
  bodyPhotoUrl,
  createItem,
  listItems,
  patchItem,
  deleteItem,
  postBodyPhoto,
  getBodyPhoto,
  suggestOutfit,
  generateOutfit,
  renderOutfit,
  postFeedback,
  getFeedback,
  getContext: getContextRoute,
  getAcceptanceMetrics,
  // exported for tests
  crossesTrainThreshold,
  localSuggest,
};

