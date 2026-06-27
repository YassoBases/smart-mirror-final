// Wraps Replicate's HTTP API for virtual try-on (VTON).
//
// Reads REPLICATE_API_TOKEN and REPLICATE_VTON_MODEL (default a current IDM-VTON
// model id). Runs one garment onto a person image and returns the output image
// URL. The model id is verified at call time — a clear error surfaces if it's
// wrong. If the token is unset, isConfigured() is false and callers fall back to
// a no-op render (returning the base body photo).

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN || "";
// Default to a current IDM-VTON model on Replicate. Override via env.
const REPLICATE_VTON_MODEL =
  process.env.REPLICATE_VTON_MODEL ||
  "cuuupid/idm-vton:c871bb9b046607b680449ecbae55fd8c6d945e0a1948644bf2361b3d021d3ff4";
// Text-to-image model for generated-garment previews. Default flux-schnell:
// flat ~$0.003/image and ~1-2s (vs SDXL's ~$0.01-0.02 and ~15-25s), with better
// quality. Override via REPLICATE_TXT2IMG_MODEL / Settings. generateImage() sends
// flux-shaped inputs (aspect_ratio) for flux models and SDXL-shaped inputs
// (width/height) otherwise, so SDXL-family ids (e.g. sdxl-lightning-4step) still
// work as overrides.
const REPLICATE_TXT2IMG_MODEL =
  process.env.REPLICATE_TXT2IMG_MODEL ||
  "black-forest-labs/flux-schnell:c846a69991daf4c0e5d016514849d14ee5b2e6846ce6b9d6f21369e564cfe51e";
// Instruction image-editing model for "render on me": edits the user's body
// photo per a text prompt, keeping the same person + background but changing the
// clothes. Default flux-kontext-pro (~$0.04/edit). Override via
// REPLICATE_IMG_EDIT_MODEL / Settings (replicate_img_edit_model).
const REPLICATE_IMG_EDIT_MODEL =
  process.env.REPLICATE_IMG_EDIT_MODEL ||
  "black-forest-labs/flux-kontext-pro:897a70f5a7dbd8a0611413b3b98cf417b45f266bd595c571a22947619d9ae462";
// Multi-image edit model for generated-outfit "render on me": takes the body
// photo + a reference image of the garments and dresses the person in them, so
// the result actually matches the suggested clothes (vs. flux-kontext-pro's
// text-only edit which invents garments). No version pinned — resolveVersion()
// fetches the latest at call time. Override via REPLICATE_MULTI_IMG_MODEL /
// Settings (replicate_multi_img_model).
const REPLICATE_MULTI_IMG_MODEL =
  process.env.REPLICATE_MULTI_IMG_MODEL ||
  "flux-kontext-apps/multi-image-kontext-pro";
// Nano Banana (Gemini 2.5 Flash Image): one-shot multi-image composer used for
// virtual try-on — give it the body photo + the garment image(s) and it dresses
// the person in them in a single call. No version pinned (resolveVersion fetches
// the latest). Override via REPLICATE_NANO_MODEL / Settings (replicate_nano_model).
const REPLICATE_NANO_MODEL =
  process.env.REPLICATE_NANO_MODEL || "google/nano-banana";

const API_BASE = "https://api.replicate.com/v1";

function isConfigured() {
  return !!REPLICATE_API_TOKEN;
}

// Image generation needs the same token; gated separately so the generate-outfit
// feature can fall back to concept-only cards when it is unavailable.
function isImageGenConfigured() {
  return !!REPLICATE_API_TOKEN;
}

// Splits "owner/name:version" → { ref, version }. Replicate's predictions API
// takes the version hash; if no ":version" is present we surface a clear error.
function parseModel(model) {
  const idx = model.indexOf(":");
  if (idx === -1) {
    throw Object.assign(
      new Error(
        `REPLICATE_VTON_MODEL must be "owner/name:version" — got "${model}"`,
      ),
      { code: "REPLICATE_MODEL_INVALID" },
    );
  }
  return { ref: model.slice(0, idx), version: model.slice(idx + 1) };
}

// Resolves a model reference to a version hash. If "owner/name:version" is given
// the version is used as-is; if only "owner/name", the latest version is fetched
// from Replicate's model API (cached per process) so callers don't have to pin a
// hash that goes stale. Returns the version string.
const _versionCache = new Map();
async function resolveVersion(model, headers) {
  const idx = model.indexOf(":");
  if (idx !== -1) return model.slice(idx + 1);
  if (_versionCache.has(model)) return _versionCache.get(model);
  const res = await fetch(`${API_BASE}/models/${model}`, { headers });
  const data = await res.json();
  if (!res.ok || !data?.latest_version?.id) {
    throw new Error(
      `Could not resolve latest version for "${model}" (${res.status}): ${
        data?.detail || "no latest_version"
      }`,
    );
  }
  _versionCache.set(model, data.latest_version.id);
  return data.latest_version.id;
}

async function poll(predictionUrl, headers, { timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(predictionUrl, { headers });
    const data = await res.json();
    if (data.status === "succeeded") return data;
    if (data.status === "failed" || data.status === "canceled") {
      throw new Error(`Replicate prediction ${data.status}: ${data.error || ""}`);
    }
    if (Date.now() > deadline) throw new Error("Replicate prediction timed out");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/**
 * Runs one VTON step.
 *
 * `category` is the IDM-VTON garment region ("upper_body" | "lower_body" |
 * "dresses"); passing it markedly improves placement vs. letting the model guess.
 * `garmentDes` should be a rich description (color + pattern + fabric + type) so
 * the model knows what it's compositing — a bare "garment" gives weak results.
 * @param {{ humanImageUrl:string, garmentImageUrl:string, garmentDes?:string, category?:string }} args
 * @returns {Promise<string>} output image URL
 */
async function tryOn({ humanImageUrl, garmentImageUrl, garmentDes, category, apiToken, model }) {
  // Prefer a token/model passed by the caller (set from the mirror Settings UI),
  // falling back to the env values.
  const token = apiToken || REPLICATE_API_TOKEN;
  const modelRef = model || REPLICATE_VTON_MODEL;
  if (!token) {
    throw Object.assign(new Error("REPLICATE_API_TOKEN not configured"), {
      code: "REPLICATE_UNSET",
    });
  }
  if (!garmentImageUrl) {
    throw Object.assign(new Error("VTON garment image URL is missing"), {
      code: "REPLICATE_GARMENT_MISSING",
    });
  }
  const { version } = parseModel(modelRef);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const input = {
    human_img: humanImageUrl,
    garm_img: garmentImageUrl,
    garment_des: garmentDes || "garment",
    // Auto-crop the person to the garment region for a tighter, more accurate
    // composite; steps tuned for quality without excessive latency.
    crop: true,
    steps: 30,
  };
  // Only valid IDM-VTON categories; omit otherwise so the model auto-detects.
  if (category && ["upper_body", "lower_body", "dresses"].includes(category)) {
    input.category = category;
  }

  const createRes = await fetch(`${API_BASE}/predictions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ version, input }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    // 422 with "version does not exist" is the classic wrong-model-id signal.
    throw new Error(
      `Replicate create failed (${createRes.status}): ${
        created?.detail || created?.title || "unknown error"
      }`,
    );
  }

  const done = await poll(created.urls.get, headers);
  const out = Array.isArray(done.output) ? done.output[done.output.length - 1] : done.output;
  if (!out) throw new Error("Replicate returned no output image");
  return out;
}

/**
 * Generates a single product-style image from a text prompt (text-to-image).
 * @param {{ prompt:string, apiToken?:string, model?:string }} args
 * @returns {Promise<string>} output image URL
 */
async function generateImage({ prompt, apiToken, model }) {
  const token = apiToken || REPLICATE_API_TOKEN;
  const modelRef = model || REPLICATE_TXT2IMG_MODEL;
  if (!token) {
    throw Object.assign(new Error("REPLICATE_API_TOKEN not configured"), {
      code: "REPLICATE_UNSET",
    });
  }
  const { version } = parseModel(modelRef);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  // flux models reject width/height (they take aspect_ratio); SDXL-family models
  // take width/height. Shape the input to match the selected model.
  const isFlux = /flux/i.test(modelRef);
  const input = isFlux
    ? { prompt, aspect_ratio: "3:4", num_outputs: 1, output_format: "jpg", go_fast: true }
    : { prompt, width: 768, height: 1024, num_outputs: 1 };

  const createRes = await fetch(`${API_BASE}/predictions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ version, input }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    throw new Error(
      `Replicate create failed (${createRes.status}): ${
        created?.detail || created?.title || "unknown error"
      }`,
    );
  }

  const done = await poll(created.urls.get, headers);
  const out = Array.isArray(done.output) ? done.output[0] : done.output;
  if (!out) throw new Error("Replicate returned no output image");
  return out;
}

/**
 * "Render on me": edits a person photo per a text instruction (flux-kontext),
 * keeping the same face + background and changing only what the prompt asks
 * (i.e. the clothes). The body image must be a PUBLIC URL Replicate can fetch.
 * @param {{ imageUrl:string, prompt:string, apiToken?:string, model?:string }} args
 * @returns {Promise<string>} output image URL
 */
async function editImage({ imageUrl, prompt, apiToken, model }) {
  const token = apiToken || REPLICATE_API_TOKEN;
  const modelRef = model || REPLICATE_IMG_EDIT_MODEL;
  if (!token) {
    throw Object.assign(new Error("REPLICATE_API_TOKEN not configured"), {
      code: "REPLICATE_UNSET",
    });
  }
  const { version } = parseModel(modelRef);
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const createRes = await fetch(`${API_BASE}/predictions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version,
      input: {
        prompt,
        input_image: imageUrl,
        output_format: "jpg",
        aspect_ratio: "match_input_image",
      },
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    throw new Error(
      `Replicate create failed (${createRes.status}): ${
        created?.detail || created?.title || "unknown error"
      }`,
    );
  }

  const done = await poll(created.urls.get, headers);
  const out = Array.isArray(done.output) ? done.output[0] : done.output;
  if (!out) throw new Error("Replicate returned no output image");
  return out;
}

/**
 * Image-conditioned "render on me": dresses the person in `imageUrl` in the
 * garments shown in `refImageUrl` (a product-style reference), keeping the same
 * face + background. Uses a multi-image Kontext model (2 image inputs). Both
 * URLs must be PUBLIC so Replicate can fetch them.
 * @param {{ imageUrl:string, refImageUrl:string, prompt:string, apiToken?:string, model?:string }} args
 * @returns {Promise<string>} output image URL
 */
async function editImageWithRef({ imageUrl, refImageUrl, prompt, apiToken, model }) {
  const token = apiToken || REPLICATE_API_TOKEN;
  const modelRef = model || REPLICATE_MULTI_IMG_MODEL;
  if (!token) {
    throw Object.assign(new Error("REPLICATE_API_TOKEN not configured"), {
      code: "REPLICATE_UNSET",
    });
  }
  if (!imageUrl || !refImageUrl) {
    throw Object.assign(new Error("body and garment reference URLs are required"), {
      code: "REPLICATE_IMAGE_MISSING",
    });
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const version = await resolveVersion(modelRef, headers);

  const createRes = await fetch(`${API_BASE}/predictions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version,
      input: {
        prompt,
        input_image_1: imageUrl,
        input_image_2: refImageUrl,
        aspect_ratio: "match_input_image",
        output_format: "jpg",
      },
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    throw new Error(
      `Replicate create failed (${createRes.status}): ${
        created?.detail || created?.title || "unknown error"
      }`,
    );
  }

  const done = await poll(created.urls.get, headers);
  const out = Array.isArray(done.output) ? done.output[0] : done.output;
  if (!out) throw new Error("Replicate returned no output image");
  return out;
}

/**
 * One-shot outfit composer (Nano Banana / Gemini Flash Image): renders the
 * person in `imageUrls[0]` wearing the garments shown in the remaining images,
 * per `prompt`. Used for both closet and generated try-on. All URLs must be
 * PUBLIC so Replicate can fetch them. Nano works best with <= 3 images, so
 * callers typically pass [bodyUrl, garmentCollageUrl].
 * @param {{ imageUrls:string[], prompt:string, apiToken?:string, model?:string }} args
 * @returns {Promise<string>} output image URL
 */
async function composeOutfit({ imageUrls, prompt, apiToken, model }) {
  const token = apiToken || REPLICATE_API_TOKEN;
  const modelRef = model || REPLICATE_NANO_MODEL;
  if (!token) {
    throw Object.assign(new Error("REPLICATE_API_TOKEN not configured"), {
      code: "REPLICATE_UNSET",
    });
  }
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    throw Object.assign(new Error("composeOutfit needs at least one image URL"), {
      code: "REPLICATE_IMAGE_MISSING",
    });
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const version = await resolveVersion(modelRef, headers);

  const createRes = await fetch(`${API_BASE}/predictions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      version,
      input: { prompt, image_input: imageUrls, output_format: "jpg" },
    }),
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    throw new Error(
      `Replicate create failed (${createRes.status}): ${
        created?.detail || created?.title || "unknown error"
      }`,
    );
  }

  const done = await poll(created.urls.get, headers);
  const out = Array.isArray(done.output) ? done.output[0] : done.output;
  if (!out) throw new Error("Replicate returned no output image");
  return out;
}

module.exports = {
  tryOn,
  generateImage,
  editImage,
  editImageWithRef,
  composeOutfit,
  isConfigured,
  isImageGenConfigured,
  parseModel,
  REPLICATE_VTON_MODEL,
  REPLICATE_TXT2IMG_MODEL,
  REPLICATE_IMG_EDIT_MODEL,
  REPLICATE_MULTI_IMG_MODEL,
  REPLICATE_NANO_MODEL,
};
