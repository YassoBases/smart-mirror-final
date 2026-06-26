// Client for the pref_ranker sidecar (services/pref_ranker, FastAPI + LightGBM).
// /score reorders Claude's candidates by the profile's learned preference;
// /train (re)fits the per-profile model. Reads PREF_RANKER_URL.
//
// Best-effort: if PREF_RANKER_URL is unset or a call fails, score() returns null
// (caller keeps Claude's order) and train() resolves false.

const PREF_RANKER_URL = process.env.PREF_RANKER_URL || "";

function isConfigured() {
  return !!PREF_RANKER_URL;
}

function url(path) {
  return `${PREF_RANKER_URL.replace(/\/$/, "")}${path}`;
}

/**
 * Scores candidate outfits for a profile.
 * @param {number} profileId
 * @param {{item_ids:number[], items:object[]}[]} candidates  enriched with item attrs
 * @param {object} context
 * @returns {Promise<number[]|null>} one score per candidate, or null if unavailable
 */
async function score(profileId, candidates, context) {
  if (!PREF_RANKER_URL) return null;
  try {
    const res = await fetch(url("/score"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, candidates, context }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data.scores) ? data.scores : null;
  } catch (err) {
    console.warn("[pref_client] score failed:", err.message);
    return null;
  }
}

/**
 * Fires a (re)train for a profile. Non-blocking by design — callers don't await.
 * @param {number} profileId
 * @param {{items:object[], context:object, label:number}[]} samples
 * @returns {Promise<boolean>} true if the sidecar trained a model
 */
async function train(profileId, samples = []) {
  if (!PREF_RANKER_URL) return false;
  try {
    const res = await fetch(url("/train"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: profileId, samples }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!data.trained;
  } catch (err) {
    console.warn("[pref_client] train failed:", err.message);
    return false;
  }
}

async function health() {
  if (!PREF_RANKER_URL) return null;
  try {
    const res = await fetch(url("/health"));
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

module.exports = { score, train, health, isConfigured };
