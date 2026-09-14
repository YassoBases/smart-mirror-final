// Garment-identity recognition: "is this the SAME physical garment as one
// already in the wardrobe" — distinct from wardrobe_attr's category/color
// classification. Compares a live embedding (services/wardrobe_attr POST
// /embed) against the profile's enrolled gallery (garment_embeddings table)
// by cosine similarity.
//
// Threshold default is a placeholder, not a calibrated value: the identity
// head hasn't been trained on real garment photos yet (see
// services/wardrobe_attr/train_identity_head.py and docs/wardrobe/
// GARMENT_RECOGNITION.md). Re-tune GARMENT_RECOGNITION_THRESHOLD once it has.
const DEFAULT_THRESHOLD = 0.8;

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function threshold() {
  const v = Number(process.env.GARMENT_RECOGNITION_THRESHOLD);
  return Number.isFinite(v) ? v : DEFAULT_THRESHOLD;
}

/**
 * @param {{item_id:number, embedding:number[], dim:number}[]} gallery
 * @param {number[]} embedding a query embedding — MUST be the same dim/space
 *   (both raw-CLIP or both identity-projected) as the gallery entries; mixing
 *   spaces silently produces meaningless similarities, so callers must not
 *   compare a projected query against a raw-CLIP gallery or vice versa.
 * @returns {{ matched: boolean, itemId: number|null, similarity: number }}
 */
function bestMatch(gallery, embedding) {
  let best = { matched: false, itemId: null, similarity: -1 };
  for (const entry of gallery) {
    if (entry.embedding.length !== embedding.length) continue; // dim mismatch — different space, skip
    const sim = cosineSimilarity(entry.embedding, embedding);
    if (sim > best.similarity) best = { matched: false, itemId: entry.item_id, similarity: sim };
  }
  if (best.itemId !== null && best.similarity >= threshold()) best.matched = true;
  return best;
}

module.exports = { cosineSimilarity, bestMatch, threshold, DEFAULT_THRESHOLD };
