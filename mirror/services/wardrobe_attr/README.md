# Wardrobe attribute classifier

The delivered service uses a frozen CLIP ViT-B/32 encoder and two independently
trained MLP head-sets over one normalized 512-dimensional image embedding:

- `clip_attr_model`: category (5), subcategory (41), formality (5), trained on
  `ashraq/fashion-product-images-small`; formality is a usage-derived proxy.
- `clip_attr_dfmm`: pattern (6), fabric (7), sleeveLength (5), neckline (7), trained
  using `train_clip_heads_dfmm_hf.py` and the upper-garment caption parser on
  `milica-vas/deepfashion-multimodal`. Each vocabulary includes `unknown`.

The local annotation trainer is a separate data path, not a reproduction of the
shipped HF model. Historical training commands disagree on sample counts; neither
checkpoint stores its split. Historical split reproduction is unverified.

## Serve

```bash
pip install -r requirements.txt
uvicorn serve_clip:app --host 0.0.0.0 --port 8003
```

Set `WARDROBE_ATTR_ENDPOINT_URL=http://127.0.0.1:8003/` in the backend environment.
Optional `WARDROBE_ATTR_ENDPOINT_TOKEN` must match the service token.
`WARDROBE_ATTR_MODEL_DIR` overrides the comma-separated model directories;
otherwise both committed head-sets load. Missing optional directories retain the
existing skip behavior. `GET /health` and multipart `POST /` remain unchanged.

The backend may send the garment image to OpenAI for a verification pass when a
key is configured and vision verification is enabled. Local head metrics measure
neither that combined classifier nor outfit recommendation or virtual try-on.

## Configuration migration

`BLIP2_ENDPOINT_URL`, `BLIP2_ENDPOINT_TOKEN`, and `BLIP2_MODEL_DIR` remain legacy
aliases for the corresponding `WARDROBE_ATTR_*` names. A new name takes priority
when present, including an empty value. Update deployment environment files.

The directory moved from `blip2_captioner` to `wardrobe_attr`. Recreate a service
virtual environment at the new path (virtual environments are not relocatable),
reinstall requirements, update/copy the classifier systemd unit, run
`sudo systemctl daemon-reload`, and restart the classifier. Verify an upload and
`/health`. Do not overwrite the committed checkpoint files during migration.

## Training and historical records

Use `train_clip_heads.py` and `train_clip_heads_dfmm_hf.py` on CUDA; these train the
heads only. HF DFMM already supports `--weight none|sqrt|inv`; its default is none.
Training improvements and retraining are outside this change.

The abandoned captioning implementation and unmodified historical records are in
[_archive_blip2](./_archive_blip2/README.md); their old relative links are historical.
`dataset_prep.py` and `attributes.py` remain shared by the local annotation path.
