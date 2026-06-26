# Phase 5 — BLIP-2 fine-tune scaffolding (no training here)

Scaffolding only; the team trains externally (Colab/RunPod) and deploys. Lives in
[services/blip2_captioner/](../../services/blip2_captioner/) with a full
[README](../../services/blip2_captioner/README.md).

- [dataset_prep.py](../../services/blip2_captioner/dataset_prep.py) — converts
  **DeepFashion-MultiModal** (default) into BLIP-2 LoRA JSONL targeting
  `subcategory, fabric, formality, neckline, sleeveLength, pattern`, with 80/10/10
  train/val/test splits. Reads the official shape/fabric/pattern annotation txts
  (label encodings noted inline, to verify against the downloaded copy).
  Fashion200K / FashionGen documented as alternatives (Fashion200K titles give
  the cleaner `subcategory` supervision DFMM lacks).
- [train.ipynb](../../services/blip2_captioner/train.ipynb) — LoRA fine-tune of
  `Salesforce/blip2-opt-2.7b` via transformers + peft (**r=16, alpha=32, target
  q/k/v/o_proj**, 4-bit base), an eval cell computing **per-attribute accuracy**,
  and a **push-to-hub** cell.
- [eval_notebook.ipynb](../../services/blip2_captioner/eval_notebook.ipynb) —
  base-vs-fine-tuned per-attribute accuracy table for the defense slide.
- [serve.py](../../services/blip2_captioner/serve.py) — FastAPI inference endpoint
  whose `POST /` matches `blip2_client` exactly; the deployed URL goes in
  `BLIP2_ENDPOINT_URL`.
- [attributes.py](../../services/blip2_captioner/attributes.py) — schema shared by
  prep, train, eval, and serve so outputs stay aligned with the API item shape.

## Output matches §2

The model predicts the six visually-grounded fields; `serve.py` adds
pixel-derived colors and rule-derived `category / warmth / seasons` via
`attributes.to_full_item_attributes`, yielding the **exact item-attribute shape**
in `01_api_contract.md` §2 — verified by running the mapping (produces
`category/subcategory/primaryColor/secondaryColors/pattern/fabricGuess/formality/
warmth/seasons/tags`). `blip2_client` validates defensively, so partial/imperfect
model output degrades gracefully instead of breaking an upload.

## Verification

No training was run (by design). All Python files compile; both notebooks are
valid `nbformat` JSON; the shared attribute mapping was executed and asserted to
produce the contract shape. Wire-up: set `BLIP2_ENDPOINT_URL` (+ optional
`BLIP2_ENDPOINT_TOKEN`) in `backend/.env` to flip the pipeline from stub
fallback to real predictions.
