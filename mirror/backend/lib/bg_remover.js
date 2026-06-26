// Client for the bg_remover sidecar (services/bg_remover, FastAPI + rembg).
// POSTs a garment image and returns a transparent PNG buffer.
//
// Best-effort by design: if BG_REMOVER_URL is unset or the call fails, the
// caller (wardrobeImageService) falls back to the resized original so the upload
// pipeline still works before the sidecar is deployed (and so tests run without
// it). Configure via BG_REMOVER_URL (default http://bg_remover:8001 in compose).

const BG_REMOVER_URL = process.env.BG_REMOVER_URL || "";

/**
 * @param {Buffer} buffer  source image bytes
 * @param {string} [mime]  source mime type (default image/jpeg)
 * @returns {Promise<Buffer>} transparent PNG bytes
 * @throws if BG_REMOVER_URL is unset or the sidecar errors
 */
async function removeBackground(buffer, mime = "image/jpeg") {
  if (!BG_REMOVER_URL) {
    throw Object.assign(new Error("BG_REMOVER_URL not configured"), {
      code: "BG_REMOVER_UNSET",
    });
  }

  const form = new FormData();
  form.append("image", new Blob([buffer], { type: mime }), "image.jpg");

  const res = await fetch(`${BG_REMOVER_URL.replace(/\/$/, "")}/remove`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    throw new Error(`bg_remover returned ${res.status}`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

function isConfigured() {
  return !!BG_REMOVER_URL;
}

module.exports = { removeBackground, isConfigured };
