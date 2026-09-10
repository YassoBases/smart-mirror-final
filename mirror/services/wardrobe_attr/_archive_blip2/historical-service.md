# BLIP-2 garment captioner — fine-tune & deploy

Scaffolding only — **no training runs in this repo**. The team trains externally
(Colab/RunPod) and deploys the result; the backend then points at it via
`BLIP2_ENDPOINT_URL`.

The model is fine-tuned to emit six visually-grounded fields as JSON:
`subcategory, fabric, formality, neckline, sleeveLength, pattern`. The serving
layer ([serve.py](serve.py)) augments that with pixel-derived colors and
rule-derived `category / warmth / seasons` via [attributes.py](attributes.py), so
the endpoint returns exactly the item-attribute shape the backend's
`blip2_client` consumes (`docs/wardrobe/01_api_contract.md` §2). Keeping
`attributes.py` shared between training, eval, and serving is what guarantees the
shapes stay aligned.

## Two paths

- **Cloud (spec):** fine-tune `blip2-opt-2.7b` (needs 12–16 GB) → `serve.py`.
- **Local (fits a 6 GB GPU):** frozen CLIP encoder + per-attribute classification
  heads → `serve_clip.py`. Trains in minutes; verified end-to-end on an RTX 3060
  (category 98.3%, see "Shipped local model" below). Use this when you can't
  access a big cloud GPU. Details:
  [docs/wardrobe/09_live_validation.md](../../docs/wardrobe/09_live_validation.md).

## Files

| File | Role |
|---|---|
| [dataset_prep.py](dataset_prep.py) | Dataset → BLIP-2 LoRA JSONL (train/val/test). |
| [train.ipynb](train.ipynb) | LoRA fine-tune of `blip2-opt-2.7b` (r=16, α=32, q/k/v/o_proj) + per-attribute eval + push-to-hub. |
| [eval_notebook.ipynb](eval_notebook.ipynb) | Base vs fine-tuned per-attribute accuracy table (defense slide). |
| [serve.py](serve.py) | FastAPI inference endpoint (cloud BLIP-2) matching `blip2_client`. |
| **[clip_heads.py](clip_heads.py)** | **Local model: frozen CLIP + per-attribute heads.** |
| **[train_clip_heads.py](train_clip_heads.py)** | **Category/subcategory/formality heads (`ashraq/fashion-product-images-small`).** |
| **[train_clip_heads_dfmm_hf.py](train_clip_heads_dfmm_hf.py)** | **Pattern/fabric/sleeve/neckline heads on real DFMM images (HF mirror, caption-parsed labels — no Google Drive).** |
| [train_clip_heads_dfmm.py](train_clip_heads_dfmm.py) | Same heads from a manual DFMM txt-annotation download. |
| **[serve_clip.py](serve_clip.py)** | **Serve one or an ensemble of head-sets (`BLIP2_MODEL_DIR="dirA,dirB"`); same `POST /` contract.** |
| [attributes.py](attributes.py) | Shared schema/mappings. |

## 1. Get a dataset

Default: **DeepFashion-MultiModal** (per-image shape + fabric + pattern labels).
Download it and its `labels/` txts. `dataset_prep.py` reads the official
annotation files; the label encodings in that script follow the dataset README —
verify against your copy.

Alternatives (documented in `dataset_prep.py`): **Fashion200K** (product titles
give strong `subcategory` supervision — recommended to complement DFMM, which has
no clean subcategory label) and **FashionGen**.

```bash
pip install -r requirements.txt
python dataset_prep.py --source /data/DeepFashion-MultiModal --out ./data
# -> data/train.jsonl  data/val.jsonl  data/test.jsonl   (80/10/10)
```

Each line: `{"image": "<abs path>", "prompt": "<instruction>", "target": "<json>"}`.

## 2. Fine-tune (Colab/RunPod GPU)

Open [train.ipynb](train.ipynb) on a CUDA host. It: 4-bit-loads BLIP-2, attaches
LoRA, trains 3 epochs on `data/train.jsonl`, computes per-attribute accuracy on
`data/test.jsonl`, saves the adapter to `./adapter`, and (last cell) pushes to the
Hub. Copy `attributes.py` next to the notebook so the eval cells import it.

## 3. Evaluate

[eval_notebook.ipynb](eval_notebook.ipynb) prints a base-vs-fine-tuned accuracy
table per attribute — the proof point for the defense slide.

## 4. Deploy & wire up

Serve the adapter with `serve.py` (its `/` endpoint matches `blip2_client`):

```bash
BLIP2_ADAPTER_DIR=./adapter \
BLIP2_ENDPOINT_TOKEN=<optional-shared-secret> \
uvicorn serve:app --host 0.0.0.0 --port 8003
```

Then in `backend/.env`:

```
BLIP2_ENDPOINT_URL=https://<your-deployed-host>/      # serve.py POST /
BLIP2_ENDPOINT_TOKEN=<same secret, if set>
```

With this set, the upload pipeline ([02/03 docs](../../docs/wardrobe/03_items_pipeline.md))
uses real predictions and returns `aiAttributesAvailable: true`. Until then the
backend's stub fallback runs and the feature still works (just with conservative
defaults the user confirms/edits).

## Shipped local model (CLIP heads — ready to serve)

Two pre-trained head-sets are committed so `serve_clip.py` works out of the box
on a 6 GB GPU (only the frozen CLIP encoder, ~0.6 GB VRAM, is downloaded at run
time; the trained heads are tiny — ~5 MB total):

- `clip_attr_model/` — category / subcategory / formality
  (trained on `ashraq/fashion-product-images-small`).
- `clip_attr_dfmm/` — pattern / fabric / sleeveLength / neckline
  (trained on the DFMM HF mirror via `train_clip_heads_dfmm_hf.py`).

Measured held-out accuracy (RTX 3060 Laptop, 6 GB):

| attribute | trained acc. | notes |
|---|---|---|
| category | **98.3%** | drives the closet tabs |
| subcategory (40-class) | **84.2%** | |
| formality | **87.5%** | |
| sleeveLength | **92.9%** | |
| pattern | **84.0%** | |
| fabric | **81.2%** | cotton-dominant; rare classes weaker |
| neckline | **71.8%** | |

`serve_clip.py` defaults to loading **both** head-sets (override with
`BLIP2_MODEL_DIR="dirA,dirB"`); a missing optional set is skipped, not fatal.
Run it and point the backend at it exactly like `serve.py`:

```bash
cd services/blip2_captioner
pip install -r requirements.txt            # + torch with CUDA for GPU
uvicorn serve_clip:app --host 0.0.0.0 --port 8003
```

```
# backend/.env
BLIP2_ENDPOINT_URL=http://<host>:8003/     # serve_clip POST /
BLIP2_ENDPOINT_TOKEN=<optional shared secret>
```

Retrain/extend: `python train_clip_heads.py ...` (category set) and
`python train_clip_heads_dfmm_hf.py --weight sqrt ...` (DFMM set; `--weight sqrt`
trades a little overall accuracy for better rare-class recall on fabric/neckline).

## Output contract (what `serve.py` returns)

```json
{ "category": "top", "subcategory": "henley", "primaryColor": "#7A8B9D",
  "secondaryColors": ["#FFFFFF"], "pattern": "solid", "fabricGuess": "cotton",
  "formality": 2, "warmth": 2, "seasons": ["spring","autumn"],
  "tags": ["long-sleeve","round"] }
```

`blip2_client` normalizes/validates this defensively, so partial or imperfect
model output degrades gracefully rather than breaking an upload.
