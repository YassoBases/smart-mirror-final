// OpenAI client for outfit suggestion + generation. Replaces the former
// Anthropic stylist and reuses the SAME prompts/schema (outfit_prompt.js +
// outfit_generate_prompt.js). Calls the Chat Completions API directly via fetch
// (no SDK dependency — same way the mirror voice assistant talks to OpenAI) with
// JSON mode so the output is strict JSON the controller already validates.
//
// One household OpenAI key powers both the stylist and the voice assistant.
// Resolution: app_settings.openai_api_key -> OPENAI_API_KEY env.
// Model: app_settings.openai_chat_model -> OPENAI_MODEL env -> "gpt-4o".

const {
  SYSTEM_PROMPT,
  RESPONSE_SCHEMA,
  buildUserPrompt,
} = require("./outfit_prompt");
const {
  GENERATE_SYSTEM_PROMPT,
  GENERATE_RESPONSE_SCHEMA,
  buildGenerateUserPrompt,
} = require("./outfit_generate_prompt");
const settings = require("../src/services/settingsService");

const API_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o";

async function resolveKey() {
  return (
    (await settings.getSetting("openai_api_key", process.env.OPENAI_API_KEY || "")) || ""
  );
}

async function resolveModel() {
  return (
    (await settings.getSetting("openai_chat_model", DEFAULT_MODEL)) || DEFAULT_MODEL
  );
}

// True when a household/env OpenAI key is available. Async (reads the settings
// store); callers already await it.
async function isConfigured() {
  return !!(await resolveKey());
}

// Calls Chat Completions and returns the parsed JSON. When `schema` is given we
// use Structured Outputs (response_format json_schema, strict) so the model is
// FORCED to return exactly that shape — plain json_object only guarantees valid
// JSON, and gpt-4o will otherwise invent its own keys (e.g. "outfits"/"items"
// instead of "candidates"/"itemIds"), which silently parses to no candidates.
async function _chatJson(systemPrompt, userPrompt, maxTokens, schema, schemaName) {
  const key = await resolveKey();
  if (!key) {
    throw Object.assign(new Error("OPENAI_API_KEY not configured"), {
      code: "OPENAI_UNSET",
    });
  }
  const model = await resolveModel();
  const response_format = schema
    ? { type: "json_schema", json_schema: { name: schemaName, strict: true, schema } }
    : { type: "json_object" };
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format,
      temperature: 0.7,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;
  if (!content) throw new Error("OpenAI returned no content");
  return JSON.parse(content);
}

/**
 * Selects outfit candidates from the wardrobe. Same signature/return as the old
 * Anthropic client so the controller is unchanged beyond the require.
 */
async function suggestOutfits({ items, context, count = 3 }) {
  const parsed = await _chatJson(
    SYSTEM_PROMPT,
    buildUserPrompt({ items, context, count }),
    2048,
    RESPONSE_SCHEMA,
    "outfit_suggestions",
  );
  return { candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [] };
}

/**
 * Invents brand-new outfit ideas (not from the closet).
 */
async function generateOutfits({ context, count = 3 }) {
  const parsed = await _chatJson(
    GENERATE_SYSTEM_PROMPT,
    buildGenerateUserPrompt({ context, count }),
    3072,
    GENERATE_RESPONSE_SCHEMA,
    "outfit_ideas",
  );
  return { candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [] };
}

// ── Vision QC layer ─────────────────────────────────────────────────────────
// Second-pass garment classifier. Shows the multimodal model the ACTUAL image
// plus the local CLIP model's guess, and asks it to correct category/
// subcategory/colors/pattern when the image contradicts them. This runs IN
// ADDITION to CLIP (not a fallback): CLIP is fast/local, this is the accuracy
// check on top. Returns the raw corrected attributes (the caller coerces+merges
// via blip2.normalizeAttributes) or null when no OpenAI key is configured / the
// verify toggle is off — in which case the caller keeps the CLIP result.

const VISION_SYSTEM_PROMPT =
  "You are a meticulous fashion cataloguer running a quality-control pass on an " +
  "automated garment classifier. You are shown ONE garment photo (its background " +
  "may be removed/white) and the classifier's current guess. Look closely at the " +
  "image and return the CORRECT attributes. Keep a field unchanged when the guess " +
  "is already right; only change it when the image clearly contradicts it. Rules:\n" +
  '- "category" MUST be exactly one of: top, bottom, outerwear, footwear, accessory.\n' +
  '- "subcategory": a short common noun for the garment (e.g. "t-shirt", "jeans", ' +
  '"sneakers", "denim jacket", "watch").\n' +
  '- "primaryColor" and each of "secondaryColors": a hex string like "#1A2B3C", ' +
  "sampled from the garment itself — ignore the background and any white padding.\n" +
  '- "pattern" MUST be exactly one of: solid, stripe, plaid, print, other.\n' +
  "Return ONLY a JSON object with keys category, subcategory, primaryColor, " +
  "secondaryColors (array of hex strings), pattern.";

/**
 * @param {{ imageBase64: string, mimeType?: string, current?: object }} args
 * @returns {Promise<object|null>} raw corrected attributes, or null (keep CLIP)
 */
async function verifyItemAttributes({ imageBase64, mimeType = "image/jpeg", current = {} }) {
  // Toggle: app_settings.wardrobe_vision_verify -> WARDROBE_VISION_VERIFY env -> on.
  const toggle = await settings.getSetting(
    "wardrobe_vision_verify",
    process.env.WARDROBE_VISION_VERIFY ?? "1",
  );
  if (toggle === "0" || toggle === false || toggle === "false") return null;

  const key = await resolveKey();
  if (!key) return null; // not configured — caller keeps the CLIP result
  const model = await resolveModel();

  const userText =
    "The local classifier guessed these attributes for the garment in the image:\n" +
    JSON.stringify({
      category: current.category,
      subcategory: current.subcategory,
      primaryColor: current.primaryColor,
      secondaryColors: current.secondaryColors,
      pattern: current.pattern,
    }) +
    "\n\nVerify against the image and return the corrected JSON.";

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 400,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenAI vision ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const content =
    data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
  if (!content) throw new Error("OpenAI vision returned no content");
  return JSON.parse(content);
}

module.exports = {
  suggestOutfits,
  generateOutfits,
  verifyItemAttributes,
  isConfigured,
  resolveKey,
  MODEL: DEFAULT_MODEL,
};
