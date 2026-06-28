// Wardrobe API for the mirror widget. The mirror holds no JWT, so it calls the
// public mirror-scoped routes keyed by the mirror's id (?mid=), which resolve the
// active profile server-side (see docs/wardrobe/00_backend_findings.md).
import { backendApi } from '../../services/backendApi';

const API_URL = (
  process.env.REACT_APP_API_URL ||
  `http://${window.location.hostname}:3000`
).replace(/\/$/, '');

const base = () =>
  `${API_URL}/api/mirrors/wardrobe`;

const mid = () => encodeURIComponent(backendApi.getMirrorId());

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    // Surface the server's `detail` (the real cause — e.g. a Replicate throttle
    // message) so failures are diagnosable instead of showing only the generic line.
    const msg = data.error || `Request failed (HTTP ${res.status})`;
    const err = new Error(data.detail ? `${msg} (${data.detail})` : msg);
    err.status = res.status;
    err.detail = data.detail || null;
    throw err;
  }
  return res.json();
}

export const wardrobeApi = {
  // All items (id -> attributes/thumbnails), used to render the flat-lay board.
  listItems: () => getJson(`${base()}/items?mid=${mid()}`),

  suggest: (count = 3, occasion = null) =>
    getJson(`${base()}/outfit/suggest?mid=${mid()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count,
        ...(occasion && occasion !== 'any' ? { occasion } : {}),
      }),
    }),

  // Invent brand-new outfit ideas (not from the closet). Items carry imageUrl +
  // searchUrl from the backend.
  generate: (count = 3, occasion = null) =>
    getJson(`${base()}/outfit/generate?mid=${mid()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count,
        ...(occasion && occasion !== 'any' ? { occasion } : {}),
      }),
    }),

  render: (itemIds) =>
    getJson(`${base()}/outfit/render?mid=${mid()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds }),
    }),

  // Render a GENERATED outfit (concept items, not from the closet) onto the body
  // photo. The backend generates a product image per garment then composites them
  // with Nano Banana Pro. Returns { generationId, tryOnUrl }.
  generateRender: (items, context = null) =>
    getJson(`${base()}/outfit/generate/render?mid=${mid()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, ...(context ? { context } : {}) }),
    }),

  // Feedback for closet outfits (itemIds) or generated outfits (items attrs).
  feedback: ({ itemIds, items, rating, reasoningShown, context }) =>
    getJson(`${base()}/outfit/feedback?mid=${mid()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemIds, items, rating, reasoningShown, context }),
    }),

  context: () => getJson(`${base()}/context?mid=${mid()}`),

  bodyPhoto: () => getJson(`${base()}/body-photo?mid=${mid()}`),
};
