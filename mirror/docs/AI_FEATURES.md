# AI features — what each one does, and where the intelligence comes from

Quick reference for every AI-driven feature in the Smart Mirror. Numbers below
are from the recorded evaluations in `docs/testing/evidence/report-alignment/`
(slice of the source dataset; training overlap not verified — see provenance).

## Which models did *we* train?

Only one thing in the product is trained by us: the **wardrobe attribute
heads** (two small classifier head-sets on top of a frozen CLIP). The
**preference ranker** trains itself per user from likes/dislikes at runtime.
Everything else is a pretrained or hosted model used as-is.

---

## 1. Garment attribute classifier (`services/wardrobe_attr`)
**What it does:** when you photograph a garment, it labels it — category,
subcategory, formality, pattern, fabric, sleeve length, neckline. Colour is
measured from pixels; warmth and seasons are rules on top.

**How it works:** a frozen **CLIP ViT-B/32** image encoder
(`openai/clip-vit-base-patch32`, 512-d features) with small heads we trained:

| Head-set | Trained on | Heads | Head shape | Training |
|---|---|---|---|---|
| `clip_attr_model` | `ashraq/fashion-product-images-small` (product photos) | category (5), subcategory (41), formality (5) | 512→512→n (GELU, dropout 0.1) | 2,500 train / 400 eval, 8 epochs, AdamW lr 1e-3, wd 1e-4, cross-entropy |
| `clip_attr_dfmm` | `milica-vas/deepfashion-multimodal` (real worn photos) | pattern (6), fabric (7), sleeve (5), neckline (7) | 512→256→n | 16,000 train / 1,500 eval, 60 epochs |

CLIP itself is never fine-tuned — only the heads learn, which is why training
runs on CPU in minutes.

**Recorded accuracy (eval slice):** category 98.4%, subcategory 84.0%,
formality 87.4%, pattern 85.1%, sleeve 91.6%, fabric 80.9%, neckline 75.6%.
Macro-F1 is much lower on fabric (0.36) and neckline (0.45): rare classes are
weak. Manual correction in the app is the designed backstop; corrections
persist. An optional **OpenAI vision** pass can double-check attributes when a
key is configured.

## 2. Background removal (`services/bg_remover`)
**What:** cuts the garment (or person) out of its background for clean
product images, try-on inputs and live-try-on layers.
**Model:** **rembg / U²-Net** (`u2net`, ~44M params), pretrained, not trained
by us. Separates foreground from background — *not* clothing from skin.

## 3. Outfit suggestion ("From my closet" / "Generate new outfit")
**What:** proposes complete outfits with a one-line reason.
**Model:** **OpenAI GPT-4o** as the stylist (prompted with your items'
attributes + context: weather, time of day, season, occasion). With no key it
falls back to a local rule-based combiner (top + bottom + footwear that match
formality/season). "Generate new outfit" invents items and can draw product
images with a text-to-image model on Replicate (SDXL by default).

## 4. Preference ranker (`services/pref_ranker`)
**What:** learns *your* taste from 👍/👎 and reorders the stylist's candidates.
**Model:** one **LightGBM** classifier per profile, trained on the backend
from your feedback the moment it has at least one like and one dislike.
Parameters: `num_leaves=7`, `learning_rate=0.05`, `n_estimators=min(80,
max(20, 4·n))`. Features per outfit (6): similarity to your liked-outfit
centroid, item co-occurrence in liked outfits, formality fit, warmth-vs-
temperature fit, season match, novelty (days since worn). Before any feedback
a heuristic scores context fit. Models persist per profile.

## 5. Virtual try-on — still ("Try it on me")
**What:** shows you wearing the selected outfit.
**Model:** **Nano Banana Pro (Google Gemini 3 Pro Image)** via Replicate —
a hosted generative image editor. Input: your saved body photo + one image per
garment + an instruction to keep the exact person, pose and background and
change only the clothing. Cached per (outfit, body photo). ~40–60 s per render.

## 6. Live try-on — "Live" and "Live+"
**Live (fast):** **MediaPipe Pose (BlazePose, lite)** tracks your shoulders and
hips from the mirror camera at up to 15 fps; the torso of the still render is
warped onto you with a similarity transform (translation, rotation, scale). No
training — pure geometry. Refreshes the still on a budget (≤9 hosted images
per minute).
**Live+ (hosted):** captures a 720p frame from the camera, sends *that*
through Nano Banana with the outfit (so the keyframe matches your real pose,
lighting and room), measures the pose on the result, and splits it into
torso, thigh, shin and foot layers — each tracked by its own joints so tops,
bottoms and shoes all follow you. Between keyframes it is still 2D warping;
each keyframe is a paid ~60 s render.

## 7. Face recognition (mirror) and enrollment (phone)
**What:** recognises who is in front of the mirror and switches profile;
flags unknown faces and pushes an alert to the household.
**Models (mirror, in-browser, `@vladmandic/face-api`):** TinyFaceDetector
(detection) → 68-point landmark net (alignment) → FaceRecognitionNet
(ResNet-34-style, **128-d embedding**). All pretrained. A person matches when
the Euclidean distance to an enrolled embedding is **< 0.6**; three
front/left/right photos are enrolled per person.
**Phone capture:** Google **ML Kit Face Detection** frames your face during
enrollment (detection only, no identity).

## 8. Hands-free gestures
**Model:** **MediaPipe Hands** (pretrained) gives 21 hand landmarks; small
rules on top decode pinch (click), open palm (dwell), fist (dismiss) and
horizontal swipe (next). No training.

## 9. Voice assistant
**Models:** **OpenAI Realtime (gpt-4o-realtime)** for speech-in/speech-out
conversation with follow-ups; **GPT-4o** for text; optional **ElevenLabs**
voice. Keys live in Settings; without them the assistant is off.

---

### Things worth saying plainly in a defense
- No end-to-end model was trained: CLIP is frozen, only the heads are ours.
- The eval numbers are on a selected slice, not a verified held-out split.
- rembg is person-vs-background, so the fast "Live" mode warps a torso
  region, not a segmented garment — Live+ exists because of this.
- Hosted features (try-on, stylist, voice) degrade gracefully: rule-based
  suggestions, plain body photo, "not configured" notices — never a crash.
