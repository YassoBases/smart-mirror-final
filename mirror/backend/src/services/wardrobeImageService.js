// Wardrobe upload pipeline.
//
//   raw upload buffer
//     -> validate it's an image, resize original to max 1024px edge (original.jpg)
//     -> bg_remover sidecar -> transparent PNG (nobg.png)   [falls back to original]
//     -> thumbnail from nobg (thumb.jpg)
//     -> BLIP-2 caption -> structured attributes            [falls back to stub]
//
// Files are written under backend/data/wardrobe/<profileId>/<itemId>/ and served
// statically at /wardrobe. The DB stores filenames only.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const wardrobeDb = require("../../db/wardrobe");
const bgRemover = require("../../lib/bg_remover");
const blip2 = require("../../lib/blip2_client");

const MAX_EDGE = 1024;
const THUMB_EDGE = 256;
const ORIGINAL_NAME = "original.jpg";
const NOBG_NAME = "nobg.png";
const THUMB_NAME = "thumb.jpg";

/** Throws 400 unless the buffer is a decodable raster image. */
async function readImageMeta(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.format || !meta.width || !meta.height) {
      throw new Error("unreadable");
    }
    return meta;
  } catch {
    throw Object.assign(new Error("Uploaded file is not a valid image"), {
      status: 400,
    });
  }
}

/**
 * Runs the full pipeline for an already-inserted item row.
 * @returns {{ files: {image_filename,nobg_filename,thumb_filename}, attributes, aiAttributesAvailable }}
 */
async function processItemUpload(buffer, profileId, itemId) {
  const meta = await readImageMeta(buffer);

  const dir = wardrobeDb.ensureDir(wardrobeDb.itemDir(profileId, itemId));

  // 1. Resized original (cap longest edge at 1024, never upscale).
  const originalJpg = await sharp(buffer)
    .rotate() // honor EXIF orientation
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  fs.writeFileSync(path.join(dir, ORIGINAL_NAME), originalJpg);

  // 2. Background removal (best-effort). On failure, use the resized original as
  //    the "nobg" image so the feature still works without the sidecar.
  let nobgPng;
  try {
    const removed = await bgRemover.removeBackground(originalJpg, "image/jpeg");
    nobgPng = await sharp(removed).png().toBuffer();
  } catch (err) {
    if (err.code !== "BG_REMOVER_UNSET") {
      console.warn("[wardrobeImage] bg removal failed, using original:", err.message);
    }
    nobgPng = await sharp(originalJpg).png().toBuffer();
  }
  fs.writeFileSync(path.join(dir, NOBG_NAME), nobgPng);

  // 3. Thumbnail from the nobg image (flatten transparency onto white for JPEG).
  const thumbJpg = await sharp(nobgPng)
    .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 82 })
    .toBuffer();
  fs.writeFileSync(path.join(dir, THUMB_NAME), thumbJpg);

  // 4. Attributes via BLIP-2 (stub fallback when unset). Hint the category from
  //    aspect ratio: clearly tall garments are more likely bottoms/full-length.
  const categoryHint = meta.height > meta.width * 1.4 ? "bottom" : undefined;
  const { attributes, available } = await blip2.captionImage(nobgPng, { categoryHint });

  return {
    files: {
      image_filename: ORIGINAL_NAME,
      nobg_filename: NOBG_NAME,
      thumb_filename: THUMB_NAME,
    },
    attributes,
    aiAttributesAvailable: available,
  };
}

/**
 * Stores the base body photo for a profile (resized, max 1024px edge).
 * @returns {string} the stored filename
 */
async function processBodyPhoto(buffer, profileId) {
  await readImageMeta(buffer);
  const dir = wardrobeDb.ensureDir(wardrobeDb.bodyDir(profileId));
  const jpg = await sharp(buffer)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  const filename = "base.jpg";
  fs.writeFileSync(path.join(dir, filename), jpg);
  return filename;
}

module.exports = { processItemUpload, processBodyPhoto, MAX_EDGE };
