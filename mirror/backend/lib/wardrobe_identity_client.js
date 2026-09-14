// Client for the garment-identity embedding endpoint on the SAME wardrobe_attr
// service (services/wardrobe_attr POST /embed) — reuses that service's already-
// loaded frozen CLIP encoder rather than standing up a second one. Distinct from
// wardrobe_attr_client.js, which calls POST / for attribute classification.
//
// Stub fallback: if WARDROBE_ATTR_ENDPOINT_URL is unset, throws with code
// "WARDROBE_IDENTITY_UNSET" so callers can degrade (e.g. skip enrollment/
// recognition) the same way bg_remover.js and wardrobe_attr_client.js do.

const WARDROBE_ATTR_ENDPOINT_URL = process.env.WARDROBE_ATTR_ENDPOINT_URL ?? process.env.BLIP2_ENDPOINT_URL ?? "";
const WARDROBE_ATTR_ENDPOINT_TOKEN = process.env.WARDROBE_ATTR_ENDPOINT_TOKEN ?? process.env.BLIP2_ENDPOINT_TOKEN ?? "";

/**
 * @param {Buffer} buffer garment image bytes (any format the service can decode)
 * @returns {Promise<{ embedding: number[], projected: boolean, dim: number }>}
 * @throws {Error & {code:'WARDROBE_IDENTITY_UNSET'}} when the endpoint isn't configured
 */
async function getEmbedding(buffer) {
  if (!WARDROBE_ATTR_ENDPOINT_URL) {
    throw Object.assign(new Error("WARDROBE_ATTR_ENDPOINT_URL not configured"), {
      code: "WARDROBE_IDENTITY_UNSET",
    });
  }

  const form = new FormData();
  form.append("image", new Blob([buffer], { type: "image/png" }), "item.png");

  const headers = {};
  if (WARDROBE_ATTR_ENDPOINT_TOKEN) {
    headers.Authorization = `Bearer ${WARDROBE_ATTR_ENDPOINT_TOKEN}`;
  }

  const res = await fetch(`${WARDROBE_ATTR_ENDPOINT_URL.replace(/\/$/, "")}/embed`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!res.ok) throw new Error(`Garment identity embedding endpoint returned ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.embedding) || !data.embedding.length) {
    throw new Error("Garment identity embedding endpoint returned no embedding");
  }
  return { embedding: data.embedding, projected: !!data.projected, dim: data.dim };
}

function isConfigured() {
  return !!WARDROBE_ATTR_ENDPOINT_URL;
}

module.exports = { getEmbedding, isConfigured };
