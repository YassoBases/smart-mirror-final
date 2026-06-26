# Wardrobe — 5-minute defense walkthrough

A gesture-by-gesture, screen-by-screen script. Times are guidance.

## Setup (before the room)

1. Backend + sidecars up (either `docker compose up --build`, or natively:
   `node backend/server.js` plus the two `uvicorn` sidecars).
2. Seed the demo data:
   ```
   node tools/seed_demo_wardrobe.js      # 32-item demo closet (profile "Demo", mirror "demo-mirror")
   node tools/synthetic_feedback.js      # 36 feedback rows + a trained-at boundary
   ```
   (Optional, for real VTON: set `REPLICATE_API_TOKEN` + `PUBLIC_BASE_URL` (ngrok)
   in `backend/.env`. Optional, for real attributes: set `BLIP2_ENDPOINT_URL`.)
3. Mirror UI running (`npm start`); enable the **Wardrobe** widget in settings.
4. Open the dashboard in a second tab: `http://<host>:3000/admin/wardrobe/?mid=demo-mirror`.

## The walkthrough

### 0:00 — Framing (30s)
"Our smart mirror now has a wardrobe stylist. It knows the user's closet,
suggests complete outfits for the weather, renders them on the user's body, and
**learns** which suggestions they actually like — all driven by gestures."

### 0:30 — Summon, hands-free (45s)
- **Gesture: open palm held to the mirror (`wardrobe_invoke`).**
- The widget shows "Choosing an outfit…", then the **OutfitBoard**: a flat-lay
  with the top centered, bottom below, and any outerwear/accessories in the
  sidebar.
- Point at the **Reasoning card**: "This is explainable — the stylist (Claude)
  references the specific items and ties them to the current weather, time of
  day, and season it pulled from the context service."

### 1:15 — Cycle candidates (30s)
- **Gesture: horizontal swipe (`next_outfit`).** The board animates to the next
  outfit; the reasoning updates. "Each candidate is a complete, valid outfit from
  the user's own wardrobe — never invented items."

### 1:45 — Virtual try-on (60s)
- **Gesture: pinch the "Try it on" target (`render_vton`).**
- VtonView loads with the OutfitBoard still visible underneath (never a blank
  screen). "We composite top then bottom onto the user's saved body photo via
  IDM-VTON on Replicate; identical outfits are cached, so re-renders are instant."
- (If Replicate isn't wired, note the fallback returns the base body photo — the
  flow is the same.)

### 2:45 — Feedback that trains the model (45s)
- **Gesture: pinch "Like" or "Not for me" (`feedback_up` / `feedback_down`).**
- "Every rating is stored per profile. Once enough feedback accrues, we train a
  per-profile LightGBM ranker that re-orders future suggestions toward what this
  user actually wears."

### 3:30 — The proof point: the dashboard (75s)
- Switch to the **acceptance dashboard** tab.
- "Here's acceptance rate per week. Before the preference model trained, the user
  accepted about **half** of suggestions. After training — the dashed line — it
  jumps to **near every** suggestion. That delta is the personalization working."
- Mention the **before/after cards** and the **model-trained date**.

### 4:45 — Close (15s)
"Gesture-driven, explainable, personalized, with virtual try-on — and it degrades
gracefully: if any AI service is offline, the feature still works with sensible
fallbacks."

## Gesture cheat-sheet

| Gesture | Action |
|---|---|
| Open-palm dwell | Summon wardrobe (`wardrobe_invoke`) |
| Horizontal swipe | Next outfit |
| Pinch "Try it on" | Render VTON |
| Pinch "Like" / "Not for me" | Feedback |
| Fist dwell | Dismiss |

## If something fails live
- No suggestion / "No active profile": re-run `seed_demo_wardrobe.js`; confirm the
  widget's mirror id is `demo-mirror` (or pass your real mirror id).
- VTON spins forever: Replicate can't reach the images — check `PUBLIC_BASE_URL`
  (ngrok) is current; the fallback still shows the body photo.
- Dashboard empty: re-run `synthetic_feedback.js`; reload with the right `?mid=`.
