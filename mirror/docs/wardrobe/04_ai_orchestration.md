# Phase 3 — AI orchestration routes + clients

## Clients (backend/lib/)

| File | Purpose | Fallback when env unset |
|---|---|---|
| [anthropic.js](../../backend/lib/anthropic.js) | Wraps `@anthropic-ai/sdk`. Model `ANTHROPIC_MODEL` (default **`claude-sonnet-4-6`**, env-overridable per spec). Uses **structured output** (`output_config.format` + a JSON schema) so the reply is strict JSON. | `isConfigured()` false → controller uses a deterministic local heuristic. |
| [replicate.js](../../backend/lib/replicate.js) | Replicate HTTP API for IDM-VTON. `REPLICATE_API_TOKEN`, `REPLICATE_VTON_MODEL` (default a current IDM-VTON `owner/name:version`). Verifies the model id shape and surfaces a clear error on a bad/`422` version. | `isConfigured()` false → render returns the base body photo (no-op). |
| [blip2_client.js](../../backend/lib/blip2_client.js) | (Phase 2) image → attributes. | stub attributes, `aiAttributesAvailable:false`. |
| [pref_client.js](../../backend/lib/pref_client.js) | pref_ranker sidecar `/score`, `/train`, `/health`. | `score()` → null (keep Claude order); `train()` → false. |
| [context.js](../../backend/lib/context.js) | OpenWeatherMap (`OWM_API_KEY`) at `HOME_LAT`/`HOME_LNG`; season from latitude+month (S-hemisphere flipped), timeOfDay from local hour. | weather/temperature null; time+season still computed locally. |
| [outfit_prompt.js](../../backend/lib/outfit_prompt.js) | The **verbatim** stylist system prompt + the response JSON schema + user-prompt builder. | — |

## Routes (added to the same dual JWT/mirror table)

- `POST /outfit/suggest` — load wardrobe **metadata only** (no image bytes) →
  get context → Claude (`suggestOutfits`) or local heuristic → **drop hallucinated
  item ids** (only ids that exist in the wardrobe survive) → re-rank via
  `pref_client.score` (skipped if no model) → `{ candidates, context }`.
- `POST /outfit/render` — sequential VTON from the base body photo: **top then
  bottom only** (outerwear/footwear/accessories are not composited — the widget
  shows them as sidebar thumbnails). Cache by `(sorted itemIds, body_photo_hash)`
  in `render_cache`; a hit returns `fromCache: true`. The render file is written
  under `…/renders/<key>.jpg` and served statically.
- `POST /outfit/feedback` — insert row; when the profile's total feedback count
  **crosses 10, 50, 100, then every 100**, fire an async (non-blocking)
  `pref_client.train` and stamp `wardrobe_pref_models.first_trained_at`.
- `GET /outfit/feedback?limit=&offset=` — paginated feedback.
- `GET /context` — `{ temperature, weather, timeOfDay, season }`.
- `GET /metrics/acceptance` — feedback bucketed into fixed 7-day windows
  (`rate = up/total`), plus `modelTrainedAt` (from the pref-model row, else the
  sidecar `/health`).

## Replicate image reachability — ngrok

VTON sends **public image URLs** (`human_img`, `garm_img`) to Replicate's cloud,
but the backend serves images from the mirror's LAN/localhost host. The render
path therefore builds the URLs it sends to Replicate from **`PUBLIC_BASE_URL`**
(`publicRoot()` in the controller), falling back to the request host when it's
unset. For a live VTON demo (chosen tunnel: **ngrok**):

```
ngrok http 3000
# copy the https forwarding URL into backend/.env:
PUBLIC_BASE_URL=https://<subdomain>.ngrok-free.app
```

The response `renderUrl` (and the cached render file) is still served from the
LAN host, since the mirror widget fetches it directly. With `PUBLIC_BASE_URL`
unset, render returns the base body photo (no VTON). The token lives in the
gitignored `backend/.env`; `.env.example` carries only placeholders. Cache/flow
logic is exercised by tests without the network.

## Tests

[wardrobe.outfit.test.js](../../backend/__tests__/wardrobe.outfit.test.js):
suggest with a **mocked Anthropic** client (asserts hallucinated-id dropping and
pref re-ranking), the Claude-throws → local fallback, render fallback + **cache
hit** (order-independent) and a **mocked Replicate** VTON path, the
`crossesTrainThreshold` schedule (`[10,50,100,200,300]`), feedback→train trigger
at the 10th row, context, and weekly metric bucketing. Full suite: **24 tests,
all passing** (`cd backend && npm test`).
