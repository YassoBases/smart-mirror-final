// Shared wardrobe controllers. Every handler reads req.wardrobeProfileId (set by
// requireProfileJwt or requireProfileMid) so the same code serves both the JWT
// (Flutter) routes and the mirror (?mid=) routes.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

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
  generateRenderSchema,
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

// Resolves a local image file to a URL the Replicate model can fetch. Uploads the
// bytes straight to Replicate's Files API so the model pulls from Replicate's own
// infra — NOT from our public tunnel (ngrok-free is slow enough that the model's
// 10s image read times out, which is the top cause of "could not render"). Falls
// back to the public URL only if the upload itself fails.
async function modelImageUrl(localPath, apiToken, fallbackUrl) {
  try {
    // Downscale/compress before upload: this box's uplink is slow, so a multi-MB
    // image takes a minute+ to leave it (and blows the render budget). A ~1024px
    // JPEG is tens of KB — uploads in seconds and is ample resolution for the
    // render. flatten() drops alpha (closet items are transparent PNGs) onto white,
    // which is also the ideal product background; rotate() honors EXIF orientation.
    const buffer = await sharp(fs.readFileSync(localPath))
      .rotate()
      .flatten({ background: "#ffffff" })
      .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    return await replicate.uploadFile({
      buffer,
      filename: path.basename(localPath, path.extname(localPath)) + ".jpg",
      apiToken,
    });
  } catch (err) {
    console.warn(
      "[wardrobe] Replicate upload failed, using public URL fallback:",
      err.message,
    );
    return fallbackUrl;
  }
}

// Rich, human-readable garment description for VTON — color + pattern + fabric +
// subcategory (e.g. "navy striped cotton t-shirt"). A bare subcategory gives the
// model almost nothing to work with, which is a top cause of weak try-on results.
function garmentDescription(row, fallback) {
  const parts = [
    row.primary_color,
    row.pattern && row.pattern !== "solid" ? row.pattern : null,
    row.fabric_guess,
    row.subcategory || row.category,
  ].filter((p) => p && String(p).trim());
  return parts.length ? parts.join(" ") : fallback;
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

    // Resolve the selected items (the whole outfit is composited at once).
    const rows = [];
    for (const id of itemIds) {
      const row = await wardrobeDb.getItem(db, id);
      if (row && row.profile_id === profileId) rows.push(row);
    }
    const bodyUrl = bodyPhotoUrl(req, profileId, bodyFilename);

    // Replicate config: prefer values set in the mirror Settings UI (app_settings),
    // fall back to env. publicBase is the origin Replicate fetches images from.
    const apiToken = await settings.getSetting("replicate_api_token", process.env.REPLICATE_API_TOKEN);
    const nanoModel = await settings.getSetting("replicate_nano_model", process.env.REPLICATE_NANO_MODEL);
    const publicBase = (
      (await settings.getSetting("public_base_url", process.env.PUBLIC_BASE_URL)) ||
      publicRoot(req)
    ).replace(/\/$/, "");

    // Try-on is "configured" when we have a token (from Settings or env). When it
    // is, a failed render is surfaced as an error rather than silently returning
    // the unchanged body photo — that silent fallback made a broken render (e.g.
    // an unreachable public_base_url) look like "nothing happened".
    const vtonConfigured = !!apiToken || replicate.isConfigured();
    let finalUrl = bodyUrl;
    let vtonRan = false;

    if (vtonConfigured) {
      // Build the garment list from each item's background-removed image; Nano
      // Banana Pro dresses the person in all of them in a single pass.
      const garments = [];
      for (const row of rows) {
        if (!row.nobg_filename) {
          console.warn(`[wardrobe] item ${row.id} has no nobg image; skipping in render`);
          continue;
        }
        garments.push({
          publicUrl: await modelImageUrl(
            path.join(wardrobeDb.itemDir(profileId, row.id), row.nobg_filename),
            apiToken,
            itemImageUrl(publicBase, profileId, row),
          ),
          description: garmentDescription(row, row.category),
        });
      }
      if (garments.length === 0) {
        return res
          .status(400)
          .json({ error: "None of the selected items have a usable image to render" });
      }
      try {
        const bodyPublicUrl = await modelImageUrl(
          bodyPath,
          apiToken,
          `${publicBase}/wardrobe/${profileId}/body/${bodyFilename}`,
        );
        finalUrl = await nanoRenderOutfit({
          bodyPublicUrl,
          garments,
          apiToken,
          model: nanoModel,
        });
        vtonRan = true;
      } catch (err) {
        console.warn("[wardrobe] Nano render failed:", err.message);
        return res.status(502).json({
          error:
            "Could not render this outfit on your photo. " +
            "Check that the server's public image URL is reachable by Replicate " +
            "and the render model/token are valid.",
          detail: err.message,
        });
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

    // Save a successful try-on into the gallery too, so closet renders show up
    // alongside generated outfits. Copy the image into generations/ (renders/ is a
    // hash-keyed cache that can be evicted). Best-effort: never fail the response.
    if (vtonRan) {
      try {
        const genDir = wardrobeDb.ensureDir(wardrobeDb.generationsDir(profileId));
        const genFilename = `${crypto.randomUUID()}.jpg`;
        fs.copyFileSync(dest, path.join(genDir, genFilename));
        await wardrobeDb.insertGeneration(db, profileId, {
          kind: "closet_render",
          title: outfitTitle(rows),
          prompt: null,
          items: rows.map(itemMetadata),
          context: null,
          filename: genFilename,
        });
      } catch (err) {
        console.warn("[wardrobe] gallery save for closet render failed:", err.message);
      }
    }

    res.json({
      renderUrl: `${serverRoot(req)}/wardrobe/${profileId}/renders/${filename}`,
      fromCache: false,
    });
  } catch (err) {
    next(err);
  }
}

// ── Outfit generation (new ideas, not from the closet) ────────────────────────

// Resolves to the promise's value, or rejects after `ms` so a hung/slow call
// (e.g. a throttled Replicate poll) can't block the caller indefinitely.
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("image gen timed out")), ms),
    ),
  ]);
}

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

// Per-render budget (garment image gen + Nano Banana Pro compose). Generous
// because nano-banana-pro alone is ~40-45s, and a low-credit Replicate account
// throttles back-to-back predictions (each garment image + the compose), so the
// retry backoffs add up. A render that exceeds it surfaces an error rather than
// hanging the response.
const TRYON_BUDGET_MS = 180000;

// Short human label for the gallery, e.g. "blazer · shirt · trousers · loafers".
function outfitTitle(items) {
  return items
    .map((it) => it.subcategory || it.category)
    .filter(Boolean)
    .slice(0, 4)
    .join(" · ");
}

// A short product-image / shopping description for one generated garment.
function garmentDescriptionFor(item) {
  return (
    (item.description && item.description.trim()) ||
    [
      item.primaryColor,
      item.pattern && item.pattern !== "solid" ? item.pattern : null,
      item.subcategory || item.category,
    ]
      .filter(Boolean)
      .join(" ")
  );
}

// The garments worth showing in the reference image / putting on the body.
function renderableGarments(items) {
  return items
    .filter((it) =>
      ["top", "bottom", "outerwear", "footwear"].includes(it.category),
    )
    .slice(0, 4);
}

// Generates a product image for one garment and stores it under the profile's
// generated/ dir, cached by prompt hash. Returns the LOCAL file path, or null
// when generation is unavailable/fails.
async function ensureItemImageFile(profileId, imagePrompt, apiToken, model) {
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
    return dest;
  } catch (err) {
    console.warn("[wardrobe] generate image failed:", err.message);
    return null;
  }
}

// Maps a wardrobe category to an IDM-VTON garment region. IDM-VTON only dresses
// Renders an outfit onto the body photo with Nano Banana Pro (Gemini 3 Pro
// Image): a single generative pass that dresses the person in all the garments at
// once — including footwear/accessories. Returns the Replicate image URL. Every
// URL must be publicly fetchable by Replicate. garments: [{ publicUrl, description }].
//
// What makes this render the actual USER (not a random model):
//   * The PRO model. Standard `google/nano-banana` swaps the face and background;
//     pro keeps the exact face, body, pose and background. See lib/replicate.js.
//   * Body photo FIRST, then ONE image per garment — never a composited collage
//     (Nano reads a collage's white background as blank space and leaves gaps).
//   * An explicit "keep this EXACT person, preserve the face" instruction.
async function nanoRenderOutfit({ bodyPublicUrl, garments, apiToken, model }) {
  const usable = garments.filter((g) => g.publicUrl);
  if (usable.length === 0) throw new Error("no garment images to render");

  const items = usable.map((g) => g.description).filter(Boolean).join(", ");
  const prompt =
    "The FIRST image is a real photo of a specific person. Keep this EXACT " +
    "person — their face, hair, facial hair, glasses, skin tone, body shape and " +
    "pose must stay 100% identical and recognizable. Do NOT generate a different " +
    "person. Edit ONLY their clothing: dress them in the items shown in the other " +
    `reference images${items ? ` (${items})` : ""}. Keep the same background, ` +
    "camera angle and lighting. Preserve the face. Photorealistic, natural fit, " +
    "full-body result.";

  return replicate.composeOutfit({
    imageUrls: [bodyPublicUrl, ...usable.map((g) => g.publicUrl)],
    prompt,
    apiToken,
    model,
  });
}

// POST /outfit/generate/render — render ONE generated outfit onto the body photo
// (on-demand). Generates a product image per garment, composites them, and feeds
// body + garment reference to a multi-image edit model so the rendered clothes
// match the suggested items. Saves the result to the gallery.
async function renderGeneratedOutfit(req, res, next) {
  try {
    const { items, context } = validate(generateRenderSchema, req.body || {});
    const profileId = req.wardrobeProfileId;
    const db = await getDb();

    // No body photo is the ONE case that should tell the app to add one.
    const bodyFilename = await wardrobeDb.getBodyPhotoFilename(db, profileId);
    if (!bodyFilename) {
      return res.status(400).json({ error: "No body photo set for this profile" });
    }

    const apiToken = await settings.getSetting(
      "replicate_api_token",
      process.env.REPLICATE_API_TOKEN,
    );
    if (!apiToken && !replicate.isImageGenConfigured()) {
      return res
        .status(503)
        .json({ error: "Outfit rendering is not configured on this server." });
    }

    const garments = renderableGarments(items);
    if (garments.length === 0) {
      return res.status(400).json({ error: "Outfit has no renderable garments" });
    }
    // Stored on the generation row as its "prompt" (what was put on the body).
    const prompt = garments
      .map((g) => garmentDescriptionFor(g))
      .filter(Boolean)
      .join(", ");

    const publicBase = (
      (await settings.getSetting("public_base_url", process.env.PUBLIC_BASE_URL)) ||
      publicRoot(req)
    ).replace(/\/$/, "");
    const txtModel = await settings.getSetting(
      "replicate_txt2img_model",
      process.env.REPLICATE_TXT2IMG_MODEL,
    );
    const nanoModel = await settings.getSetting(
      "replicate_nano_model",
      process.env.REPLICATE_NANO_MODEL,
    );

    try {
      const result = await withTimeout(
        (async () => {
          // 1) Generate a product image per garment and build the garment list.
          const garmentRefs = [];
          for (const g of garments) {
            const p = await ensureItemImageFile(
              profileId,
              garmentDescriptionFor(g),
              apiToken,
              txtModel,
            );
            if (!p) continue;
            garmentRefs.push({
              publicUrl: await modelImageUrl(
                p,
                apiToken,
                `${publicBase}/wardrobe/${profileId}/generated/${path.basename(p)}`,
              ),
              description: garmentDescriptionFor(g),
            });
          }
          if (garmentRefs.length === 0) {
            throw new Error("could not generate garment reference images");
          }

          // 2) Dress the body in the generated garments with Nano Banana Pro,
          // which preserves the user's face/identity in a single pass.
          const bodyPublicUrl = await modelImageUrl(
            path.join(wardrobeDb.bodyDir(profileId), bodyFilename),
            apiToken,
            `${publicBase}/wardrobe/${profileId}/body/${bodyFilename}`,
          );
          const outUrl = await nanoRenderOutfit({
            bodyPublicUrl,
            garments: garmentRefs,
            apiToken,
            model: nanoModel,
          });

          // 4) Save the render and a gallery entry.
          const r = await fetch(outUrl);
          const buf = Buffer.from(await r.arrayBuffer());
          const dir = wardrobeDb.ensureDir(wardrobeDb.generationsDir(profileId));
          const filename = `${crypto.randomUUID()}.jpg`;
          fs.writeFileSync(path.join(dir, filename), buf);
          const id = await wardrobeDb.insertGeneration(db, profileId, {
            kind: "generated_tryon",
            title: outfitTitle(items),
            prompt,
            items,
            context: context || null,
            filename,
          });
          return {
            generationId: id,
            tryOnUrl: `${serverRoot(req)}/wardrobe/${profileId}/generations/${filename}`,
          };
        })(),
        TRYON_BUDGET_MS,
      );
      res.json(result);
    } catch (err) {
      console.warn("[wardrobe] generated-outfit render failed:", err.message);
      return res.status(502).json({
        error:
          "Could not render this outfit on your photo. Check that the server's " +
          "public image URL is reachable by Replicate and the render model/token " +
          "are valid.",
        detail: err.message,
      });
    }
  } catch (err) {
    next(err);
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

    // Shopping links are synchronous and always attached.
    for (const cnd of candidates) {
      cnd.items = Array.isArray(cnd.items) ? cnd.items : [];
      for (const item of cnd.items) {
        item.searchUrl = shoppingSearchUrl(item);
        item.imageUrl = null;
      }
      cnd.tryOnUrl = null;
    }

    // Re-rank so the order the user sees reflects their learned preference.
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

    // Rendering "on me" is now on-demand (POST /outfit/generate/render): generate
    // returns concept cards instantly with tryOnUrl null, and the app renders the
    // single outfit the user picks. Keeps generate fast and only spends image
    // credit on outfits the user actually wants to see on themselves.
    res.json({ candidates, context });
  } catch (err) {
    next(err);
  }
}

// ── Saved generations gallery ─────────────────────────────────────────────────

async function listGenerationsRoute(req, res, next) {
  try {
    const db = await getDb();
    const q = req.query || {};
    const limit = Math.min(Number(q.limit) || 50, 100);
    const offset = Number(q.offset) || 0;
    const rows = await wardrobeDb.listGenerations(db, req.wardrobeProfileId, {
      limit,
      offset,
    });
    res.json({
      generations: rows.map((r) => wardrobeDb.serializeGeneration(r, serverRoot(req))),
    });
  } catch (err) {
    next(err);
  }
}

async function deleteGenerationRoute(req, res, next) {
  try {
    const db = await getDb();
    const id = Number(req.params.id);
    const row = await wardrobeDb.getGeneration(db, id);
    if (!row || row.profile_id !== req.wardrobeProfileId) {
      return res.status(404).json({ error: "Generation not found" });
    }
    // Best-effort: delete the saved image file alongside the row.
    try {
      fs.unlinkSync(
        path.join(wardrobeDb.generationsDir(req.wardrobeProfileId), row.image_filename),
      );
    } catch {
      /* file already gone — ignore */
    }
    await wardrobeDb.deleteGeneration(db, id);
    res.status(204).end();
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
  renderGeneratedOutfit,
  renderOutfit,
  listGenerations: listGenerationsRoute,
  deleteGeneration: deleteGenerationRoute,
  postFeedback,
  getFeedback,
  getContext: getContextRoute,
  getAcceptanceMetrics,
  // exported for tests
  crossesTrainThreshold,
  localSuggest,
};

