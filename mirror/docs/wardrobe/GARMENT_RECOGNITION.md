# Garment-identity recognition ("is this a garment I already own?")

Recognizes the SPECIFIC physical garment someone is wearing (not just its
category) by comparing a CLIP embedding against the profile's enrolled
gallery. Distinct from `services/wardrobe_attr`'s attribute classification
(category/color/pattern/etc.), which runs independently and unchanged.

## Step 0 — where to put your photos

```
mirror/services/wardrobe_attr/identity_data/
  navy_hoodie/
    front.jpg
    side.jpg
    back.jpg
  blue_jeans/
    01.jpg
    02.jpg
    03.jpg
  ... (10-15 garments, 3-5 photos each, different angles)
```

One folder per **physical garment**, named however you like (the folder name
is only used in training log output, never shown to a user). `identity_data/`
is gitignored-by-convention the same way trained checkpoints are — it's your
personal photos, not committed. Each garment needs **at least 2 photos** (one
gets held out to evaluate against); the plan calls for 3-5.

## Training

```
cd mirror/services/wardrobe_attr
python train_identity_head.py --data ./identity_data --out ./clip_identity_head
```

What it does: loads the frozen CLIP encoder already used for attribute
classification (`clip_heads.py`'s `ClipAttr.features()` — no second CLIP
instance), holds out one photo per garment as a test query, trains a small
projection head (`identity_head.py`: Linear→GELU→Linear, 512→256→128,
L2-normalized output) with a cosine triplet loss, and prints:

```
method                  top-1 accuracy    correct/total
baseline (frozen CLIP)  X.XXX             n/N
trained (projection)    X.XXX             n/N
```

If the trained number doesn't beat the baseline, the script says so plainly
instead of the run being re-tuned to hide it — see "Results" below for what
actually happened this session (synthetic data only; no real photos existed
yet). Saves `head.pt` + `config.json` to `--out` (default
`clip_identity_head/`, loaded automatically by `serve_clip.py` if present —
restart the service to pick up a newly trained head).

## Serving

`serve_clip.py` gained one route: `POST /embed` — takes an image, returns the
frozen-CLIP embedding (or the identity-projected one, once trained). Reported
as `{ embedding, projected, dim }`; `projected: false` until a head exists at
`WARDROBE_IDENTITY_MODEL_DIR` (default `clip_identity_head/` next to
`clip_attr_model/`). `GET /health` now also reports `identity_head_trained`.

## Backend

Two mirror/JWT-mounted routes (`backend/src/routes/wardrobe.js`), same
dual-route pattern as everything else in this file:

- `POST /wardrobe/recognize` — multipart, 1-5 images under `images` (a short
  burst captured while someone is stably present). **Never persists
  anything** — embeds each frame via `/embed`, averages+renormalizes
  (the "combine a short window of frames" step), compares against the
  profile's gallery (`garment_embeddings` table) by cosine similarity, and
  returns `{ status: 'recognized', item, similarity }` or
  `{ status: 'unknown', similarity }`. 503 `{status:'unavailable'}` if the
  identity service isn't configured.
- `POST /wardrobe/recognize/enroll` — multipart, one confirmed image under
  `image`. The **only** route that creates anything: runs the image through
  `createItemFromBuffer` — the exact same function `POST /wardrobe/items`
  (manual upload) calls — then embeds the resulting `nobg.png` and stores it
  in `garment_embeddings`. An auto-enrolled item is structurally identical to
  a manually-added one; nothing about the API shape differs (verified live,
  see "Verification" below).

Threshold: `GARMENT_RECOGNITION_THRESHOLD` env var, default `0.8`
(`garmentRecognitionService.js`). **This default is a placeholder, not a
calibrated value** — see "Known limitation" below.

## Frontend

- `useGarmentRecognition.js`: mounted inside the Wardrobe widget, active only
  while it's idle (not mid-browse or mid-try-on, so it never competes for
  screen space with those). Waits for the mirror's existing pose-presence
  signal (`poseTracking.js`) to be visible continuously for 1.2s, captures a
  burst of 3 torso crops 350ms apart, calls `/recognize`. One decision per
  presence session — tracked by a ref that resets when presence is lost for
  2.5s+ (a new person) or the hook restarts.
- Recognized: shows which item it is, no prompt.
- Unknown: shows a Yes/No prompt (`GarmentRecognitionOverlay.jsx`, same
  button style as `FeedbackHint.jsx`) plus the existing open-palm/fist dwell
  gestures (`gestureMap.js`'s `createGestureRecognizer`) as the hands-free
  equivalent — no new gesture primitive was invented. Times out after 15s
  with no response, treated as decline; won't re-prompt for the same
  presence session either way.
- **No image is captured, sent, or stored before a person is confirmed.** The
  frames used for the "known or unknown" check are only ever embedded
  in-memory (both in the browser and on the backend) and discarded — see the
  Verification section for how this was checked, not just asserted.
- Confirm "yes": shows "Adding to your wardrobe…", calls
  `/recognize/enroll`, then shows the actual added item (thumbnail +
  attributes) for a few seconds.

## Verification (acceptance criterion: app-facing shape parity)

Checked two ways, not just assumed from code reuse:

1. **Automated**: `backend/__tests__/wardrobe.recognition.test.js` enrolls an
   item via `/recognize/enroll`, creates another manually via `/items`, then
   calls `GET /items` and diffs `Object.keys()` and per-field `typeof` between
   the two — real HTTP round-trip through the real Express app + SQLite DB
   (identity service mocked).
2. **Live, this session**: started the real backend + real `wardrobe_attr`
   service (no mocks), registered a real household/profile, called
   `/recognize/enroll` and `/items` for real, and diffed the JSON by hand:

   ```
   enroll keys: category,createdAt,fabricGuess,formality,id,imageUrl,lastWornAt,
                pattern,primaryColor,profileId,seasons,secondaryColors,
                subcategory,tags,thumbnailUrl,warmth
   manual keys: <identical>
   keys match: true
   no embedding leaked into item shape: true
   ```

   Also confirmed live: recognizing the enrolled item's own photo again
   returned `{"status":"recognized","similarity":0.9977,...}` matching item
   id 17 (not the separately-created twin, id 18) — and calling `/recognize`
   never changed the item count (2 before, 2 after).

## Known limitation — the default threshold is not calibrated, and here's proof

No real garment photos existed for this session (see Step 0 — they hadn't
been photographed yet), so `train_identity_head.py` was only run against a
synthetic smoke-test dataset (six flat-color vector shapes) to prove the
pipeline works mechanically. Both baseline and trained hit 100% on that
synthetic set — it's trivially separable by color, not a meaningful number.

Separately, while live-verifying the backend (see above), a genuinely
different synthetic garment (a dark trouser shape vs. the enrolled red shirt
shape) was reported as **recognized** at similarity 0.824 — above the default
0.8 threshold — when it should have been unknown. This is real evidence, not
a hypothetical: **raw, untrained CLIP embeddings cluster simple flat-color
"product photo on white background" images together somewhat regardless of
garment identity**, which is exactly the failure mode the identity head is
meant to fix by pushing different garments' embeddings apart during
training. The threshold was deliberately left at 0.8 rather than tuned
against this one synthetic case — real photos plus a real
baseline-vs-trained run from `train_identity_head.py` is what should set it,
not a synthetic pair chosen after the fact.

**Action once real photos exist**: re-run `train_identity_head.py`, read the
printed baseline/trained accuracy, and set `GARMENT_RECOGNITION_THRESHOLD` to
whatever separates true matches from non-matches in that real report —
`services/pref_ranker`-style per-profile tuning is future scope, not
attempted here.
