// Generic key/value app settings (integration keys + AI config configured from
// either Settings page). Single household per backend, so a flat KV is enough.
// Read at request time, env value used as the fallback.
const { getDb } = require("../config/database");

async function getSetting(key, fallback = null) {
  const db = await getDb();
  const row = await db.get("SELECT value FROM app_settings WHERE key = ?", key);
  return row && row.value != null && row.value !== "" ? row.value : fallback;
}

async function setSetting(key, value) {
  const db = await getDb();
  await db.run(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    key,
    value,
  );
}

// The shared (household-wide) settings both the app and mirror Settings pages
// edit, and that the backend stylist + mirror voice assistant consume. Each maps
// a camelCase API field to its app_settings key. `secret` fields are masked on
// read unless includeSecrets is set (the mirror voice assistant needs the raw
// OpenAI key client-side, exactly as it does today).
const SHARED_FIELDS = {
  openaiApiKey: { key: "openai_api_key", secret: true },
  chatModel: { key: "openai_chat_model", default: "gpt-4o" },
  realtimeModel: { key: "openai_realtime_model", default: "gpt-4o-realtime-preview-2024-12-17" },
  voice: { key: "openai_voice", default: "alloy" },
  assistantName: { key: "assistant_name", default: "Mirror" },
  elevenLabsKey: { key: "eleven_labs_key", secret: true },
  elevenLabsVoiceId: { key: "eleven_labs_voice_id", default: "" },
  showRawTranscripts: { key: "show_raw_transcripts", default: "false", bool: true },
  replicateApiToken: { key: "replicate_api_token", secret: true },
  replicateModel: { key: "replicate_vton_model", default: "" },
  replicateTxt2imgModel: { key: "replicate_txt2img_model", default: "" },
  publicBaseUrl: { key: "public_base_url", default: "" },
};

// Returns the shared settings. Secrets are returned as `<field>Configured`
// booleans; when includeSecrets is true the raw secret value is also included
// (used by the mirror, whose voice assistant calls OpenAI directly).
async function getSharedSettings({ includeSecrets = false } = {}) {
  const out = {};
  for (const [name, meta] of Object.entries(SHARED_FIELDS)) {
    const val = await getSetting(meta.key, meta.default != null ? meta.default : "");
    if (meta.secret) {
      out[`${name}Configured`] = !!val;
      if (includeSecrets) out[name] = val || "";
    } else if (meta.bool) {
      out[name] = val === "true" || val === true || val === "1";
    } else {
      out[name] = val != null ? val : "";
    }
  }
  return out;
}

// Applies a partial patch. Secrets are only overwritten when a non-empty value
// is sent (so a masked read round-tripped back won't wipe a stored key).
async function setSharedSettings(patch = {}) {
  for (const [name, meta] of Object.entries(SHARED_FIELDS)) {
    if (!(name in patch)) continue;
    let v = patch[name];
    if (meta.secret) {
      if (typeof v === "string" && v.trim()) await setSetting(meta.key, v.trim());
      continue;
    }
    if (meta.bool) {
      v = v === true || v === "true" || v === "1" ? "true" : "false";
    }
    if (v == null) v = "";
    await setSetting(meta.key, typeof v === "string" ? v.trim() : String(v));
  }
  return getSharedSettings();
}

module.exports = {
  getSetting,
  setSetting,
  getSharedSettings,
  setSharedSettings,
  SHARED_FIELDS,
};
