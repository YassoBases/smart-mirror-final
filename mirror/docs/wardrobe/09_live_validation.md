# Live validation — what was actually run (2026-06-21)

Real-environment validation of the parts that need external services/hardware, on
the owner's Windows machine (RTX 3060 Laptop, 6 GB).

## Docker — not installed (intentional)

Docker is **not required** and was not installed (Docker Desktop is a large
admin/reboot change for zero functional gain — the backend runs via `node
server.js` and the sidecars via `uvicorn`). The compose file is validated and
ready for any Docker host. The "all three services up + /health 200" check was
already done natively.

## Live VTON (Replicate + ngrok) — wired and reached Replicate; blocked on credit

End-to-end path exercised:
1. ngrok tunnel up (`https://…ngrok-free.dev` → backend:3000); authtoken already
   configured.
2. Backend started with `PUBLIC_BASE_URL=<ngrok>`; real VITON-HD test images
   (person + garment) fetched from the public IDM-VTON example set into
   `tools/demo_assets/vton_test/`.
3. Uploaded the person as the demo body photo and the garment as a top item via
   the mirror routes, then called `POST /outfit/render`.
4. The backend correctly built **public** image URLs (ngrok) and called Replicate
   IDM-VTON. Replicate returned **HTTP 402 — insufficient credit**.

So the wiring works up to the model run; the token is valid (`/v1/account` → 200)
but the account has no credit. **Action for the owner:** add credit at
replicate.com/account/billing, keep `PUBLIC_BASE_URL` set to the current ngrok
URL in `backend/.env`, and re-run. The backend's graceful fallback (return the
body photo) was confirmed on the 402.

## GPU training — the spec model can't fit 6 GB; a real fine-tune was run instead

- CUDA verified: `torch 2.5.1+cu121`, `cuda.is_available() == True`, GPU matmul OK.
- **BLIP-2-opt-2.7B does not fit 6 GB** (≈7.4 GB to load fp16; QLoRA wants
  12–16 GB; `bitsandbytes` 4-bit is unreliable on Windows). Train it in the cloud
  via [train.ipynb](../../services/blip2_captioner/train.ipynb), as the
  scaffolding says.
- To honor "train on my GPU", a **real LoRA fine-tune of the smaller BLIP-base**
  captioner was run on the GPU over a subset of `ashraq/fashion-product-images-small`:
  [train_on_gpu_demo.py](../../services/blip2_captioner/train_on_gpu_demo.py).
  Result: **loss 4.17 → 0.82** over 100 steps, **peak VRAM 1.42 GB**, and clear
  before/after — the base model emits generic captions ("a woman in pink pants
  and a gray shirt") while the tuned model emits the structured attribute format
  ("grey tshirts, casual", "red tshirts, casual"). This demonstrates the fashion
  attribute fine-tune pipeline on the actual GPU; the production captioner is the
  2.7B model trained in the cloud.

## Gesture recapture — train/export validated; record needs a webcam

`tools/gesture_recapture.py train` was run on synthetic separable landmark
samples: it trained the MLP head and exported a well-formed `wardrobe_gesture.json`
(labels, input_dim 63, layer shapes). The **record** step is inherently a human
task (webcam + a person performing the gesture) and was not run; the synthetic
samples/model were removed afterward so no misleading artifact remains. The
shipped widget uses the geometric `wardrobe_invoke` (open-palm dwell) and does
not require this learned model.

## Local-GPU attribute model (CLIP heads) — trained, served, wired, verified

Since BLIP-2-2.7B can't train on 6 GB, the chosen local approach (Option B) is a
**frozen CLIP image encoder + per-attribute classification heads**, all on the
6 GB GPU:

- [clip_heads.py](../../services/blip2_captioner/clip_heads.py) — frozen
  `openai/clip-vit-base-patch32` + a linear head per attribute.
- [train_clip_heads.py](../../services/blip2_captioner/train_clip_heads.py) —
  trains category/subcategory/formality on `ashraq/fashion-product-images-small`.
  MLP heads (`--hidden 256`) + 8k samples / 40 epochs (majority baseline →
  trained): category **41.5% → 98.5%**, subcategory **19.7% → 85.7%** (40
  classes), formality **75.9% → 88.2%**. **Peak VRAM 0.58 GB.** (An earlier
  small linear run gave 92.7% / 37% — the bigger MLP run is the recommended one.)
- **pattern / fabric / sleeveLength / neckline** — trained on **real
  DeepFashion-MultiModal images** via the auto-downloadable HF mirror
  `milica-vas/deepfashion-multimodal` (its per-image captions state the
  attributes — e.g. "its fabric is cotton, and it has pure color patterns" — which
  [train_clip_heads_dfmm_hf.py](../../services/blip2_captioner/train_clip_heads_dfmm_hf.py)
  parses for the upper garment). **No Google Drive needed.** 16k train / 1.5k
  eval, 60 epochs, "unknown" parser-labels masked from the loss, accuracy measured
  on **known labels** (majority baseline → trained): **pattern 54% → 85%**,
  **fabric 78.3% → 81.9%**, **sleeveLength 35% → 92.5%**, **neckline 59% → 78.5%**.
  Peak VRAM 0.59 GB. Features are cached after the first run so weighting can be
  re-tuned without re-encoding.

  **Class-weighting trade-off (measured, fabric head):** full inverse-frequency
  weighting *hurt* the cotton-dominated head (→57% overall). `--weight none` gives
  the best overall accuracy (fabric 81%, cotton recall 93%) but under-recognizes
  rare fabrics; `--weight sqrt` trades overall (fabric 74%) for much better rare
  recall (denim 20%→53%, chiffon 35%→52%, furry 0%→29%; macro-recall 34%→46%).
  **Decision: `none` is the default** (`clip_attr_dfmm`) for highest overall
  accuracy; the balanced model is kept as `clip_attr_dfmm_sqrt` — switch by
  pointing `BLIP2_MODEL_DIR` at it. (Leather, ~2 eval samples, stays unlearnable
  with this data — only more balanced fabric data would move the rarest classes.)
  [train_clip_heads_dfmm.py](../../services/blip2_captioner/train_clip_heads_dfmm.py)
  is the equivalent for a manual DFMM **txt-annotation** download.
- **Ensemble verified end-to-end:** both head-sets share **one** frozen CLIP
  encoder; serving with `BLIP2_MODEL_DIR="./clip_attr_model,./clip_attr_dfmm"`
  produced correct attributes on real garments — a plain tee →
  `pattern:solid, fabric:cotton, sleeve:short-sleeve`; a graphic shirt →
  `pattern:print, …` — i.e. the full §2 shape with every attribute populated.
- [serve_clip.py](../../services/blip2_captioner/serve_clip.py) — same
  `POST /` contract as `blip2_client`; emits the §2 item shape (predicted
  category/subcategory/formality + pixel colors + rule-derived rest).
- **End-to-end verified:** with `BLIP2_ENDPOINT_URL=http://127.0.0.1:8003/`, an
  upload through the backend returned `aiAttributesAvailable: true` with
  category=`top`, subcategory=`tshirts`, real color — the full local model →
  production path.

### Use it

```
cd services/blip2_captioner
# category/subcategory/formality (auto-downloads its dataset):
python train_clip_heads.py --train 8000 --eval 800 --epochs 40 --hidden 256
# pattern/fabric/sleeve/neckline on REAL DFMM images (auto-downloads from HF):
python train_clip_heads_dfmm_hf.py --train 6000 --eval 600 --epochs 40
#   (or, for a manual DFMM txt download: train_clip_heads_dfmm.py --source <dir>)
# serve both as an ensemble (one shared CLIP encoder):
BLIP2_MODEL_DIR="./clip_attr_model,./clip_attr_dfmm" uvicorn serve_clip:app --port 8003
# then in backend/.env:  BLIP2_ENDPOINT_URL=http://127.0.0.1:8003/
```

## Test assets left in place

`tools/demo_assets/vton_test/` holds the fetched person + garment images for
re-running the VTON test once Replicate has credit.
