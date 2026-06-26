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
  buildUserPrompt,
} = require("./outfit_prompt");
const {
  GENERATE_SYSTEM_PROMPT,
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

async function _chatJson(systemPrompt, userPrompt, maxTokens) {
  const key = await resolveKey();
  if (!key) {
    throw Object.assign(new Error("OPENAI_API_KEY not configured"), {
      code: "OPENAI_UNSET",
    });
  }
  const model = await resolveModel();
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
      response_format: { type: "json_object" }, // strict JSON object
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
  );
  return { candidates: Array.isArray(parsed.candidates) ? parsed.candidates : [] };
}

module.exports = {
  suggestOutfits,
  generateOutfits,
  isConfigured,
  resolveKey,
  MODEL: DEFAULT_MODEL,
};
