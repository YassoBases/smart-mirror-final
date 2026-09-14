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
  extractLayer: async (image) => {
    const body = new FormData();
    body.append('image', image, 'keyframe.png');
    const response = await fetch(`${base()}/live/layer?mid=${mid()}`, {
      method: 'POST', body, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Background removal unavailable');
    return response.blob();
  },
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

  // Hosted "Live+" keyframe: dress the person in a frame captured from the
  // mirror's camera right now (not the saved body photo). Slow (a Nano Banana
  // pass, tens of seconds), never cached, and every call costs hosted images —
  // the caller's budget governs how often this is hit.
  renderLive: (itemIds, frame) => {
    const body = new FormData();
    body.append('itemIds', JSON.stringify(itemIds));
    body.append('frame', frame, 'frame.jpg');
    return getJson(`${base()}/outfit/render/live?mid=${mid()}`, {
      method: 'POST', body, signal: AbortSignal.timeout(190000),
    });
  },

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

  // Garment-identity recognition. `frames` (Blob[]) is a short burst captured
  // while someone is stably in view — never sent unless the caller already
  // decided to check; nothing about this call is persisted server-side.
  // Resolves { status: 'recognized', item, similarity } | { status: 'unknown', similarity }.
  recognizeGarment: (frames) => {
    const body = new FormData();
    frames.forEach((frame, i) => body.append('images', frame, `frame${i}.jpg`));
    return getJson(`${base()}/recognize?mid=${mid()}`, {
      method: 'POST', body, signal: AbortSignal.timeout(20000),
    });
  },

  // Only call after the user has explicitly confirmed on-screen — this is the
  // one call in this file that actually creates and stores something. `frame`
  // is the single confirmed capture; runs it through the normal item-creation
  // pipeline and enrolls it for future recognition.
  enrollGarment: (frame) => {
    const body = new FormData();
    body.append('image', frame, 'garment.jpg');
    return getJson(`${base()}/recognize/enroll?mid=${mid()}`, {
      method: 'POST', body, signal: AbortSignal.timeout(30000),
    });
  },
};
