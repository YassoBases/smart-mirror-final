// Client for the fine-tuned BLIP-2 captioner endpoint (services/blip2_captioner,
// deployed externally on Colab/RunPod). POSTs a garment image and returns the
// structured attribute JSON matching the item attribute shape in the API
// contract (§2 of docs/wardrobe/01_api_contract.md).
//
// Stub fallback: if BLIP2_ENDPOINT_URL is unset, returns conservative defaults
// with available=false so the route can set aiAttributesAvailable=false and the
// app can prompt the user to fill attributes in. This keeps the upload pipeline
// working before the model is deployed.

const BLIP2_ENDPOINT_URL = process.env.BLIP2_ENDPOINT_URL || "";
const BLIP2_ENDPOINT_TOKEN = process.env.BLIP2_ENDPOINT_TOKEN || "";

const VALID_CATEGORIES = ["top", "bottom", "outerwear", "footwear", "accessory"];
const VALID_PATTERNS = ["solid", "stripe", "plaid", "print", "other"];
const VALID_SEASONS = ["winter", "spring", "summer", "autumn"];

// Northern-hemisphere season for the current month — the conservative default
// season when the model can't tell us.
function currentSeason(date = new Date()) {
  const m = date.getMonth() + 1;
  if (m === 12 || m <= 2) return "winter";
  if (m <= 5) return "spring";
  if (m <= 8) return "summer";
  return "autumn";
}

/**
 * Conservative defaults used when BLIP-2 is unavailable. `category` may be
 * hinted from the upload's aspect ratio (tall → likely a full garment/bottom).
 */
function stubAttributes({ categoryHint } = {}) {
  return {
    category: VALID_CATEGORIES.includes(categoryHint) ? categoryHint : "top",
    subcategory: null,
    primaryColor: null,
    secondaryColors: [],
    pattern: "solid",
    fabricGuess: null,
    formality: 3,
    warmth: 3,
    seasons: [currentSeason()],
    tags: [],
  };
}

// Coerces a raw model response into the strict attribute shape (drops invalid
// enum values, clamps 1..5, ensures arrays). Defensive: the endpoint is
// fine-tuned but external, so never trust its output blindly.
function normalizeAttributes(raw, fallback) {
  const out = { ...fallback };
  if (!raw || typeof raw !== "object") return out;

  if (VALID_CATEGORIES.includes(raw.category)) out.category = raw.category;
  if (typeof raw.subcategory === "string") out.subcategory = raw.subcategory;
  if (typeof raw.primaryColor === "string") out.primaryColor = raw.primaryColor;
  if (Array.isArray(raw.secondaryColors))
    out.secondaryColors = raw.secondaryColors.filter((c) => typeof c === "string");
  if (VALID_PATTERNS.includes(raw.pattern)) out.pattern = raw.pattern;
  if (typeof raw.fabricGuess === "string") out.fabricGuess = raw.fabricGuess;
  if (Number.isFinite(raw.formality))
    out.formality = Math.min(5, Math.max(1, Math.round(raw.formality)));
  if (Number.isFinite(raw.warmth))
    out.warmth = Math.min(5, Math.max(1, Math.round(raw.warmth)));
  if (Array.isArray(raw.seasons))
    out.seasons = raw.seasons.filter((s) => VALID_SEASONS.includes(s));
  if (Array.isArray(raw.tags))
    out.tags = raw.tags.filter((t) => typeof t === "string");
  return out;
}

/**
 * @param {Buffer} buffer  transparent-PNG (nobg) garment bytes
 * @param {{ categoryHint?: string }} [opts]
 * @returns {Promise<{ attributes: object, available: boolean }>}
 */
async function captionImage(buffer, opts = {}) {
  const fallback = stubAttributes(opts);

  if (!BLIP2_ENDPOINT_URL) {
    return { attributes: fallback, available: false };
  }

  try {
    const form = new FormData();
    form.append("image", new Blob([buffer], { type: "image/png" }), "item.png");

    const headers = {};
    if (BLIP2_ENDPOINT_TOKEN) {
      headers.Authorization = `Bearer ${BLIP2_ENDPOINT_TOKEN}`;
    }

    const res = await fetch(BLIP2_ENDPOINT_URL.replace(/\/$/, ""), {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) throw new Error(`BLIP-2 endpoint returned ${res.status}`);
    const raw = await res.json();
    return { attributes: normalizeAttributes(raw, fallback), available: true };
  } catch (err) {
    // Endpoint down / misconfigured — degrade to stub rather than failing upload.
    console.warn("[blip2_client] caption failed, using stub:", err.message);
    return { attributes: fallback, available: false };
  }
}

module.exports = {
  captionImage,
  stubAttributes,
  normalizeAttributes,
  currentSeason,
  isConfigured: () => !!BLIP2_ENDPOINT_URL,
};
