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

## Evaluate an explicit slice

```bash
python evaluate_clip_heads.py --headset fashion --model ./clip_attr_model --train 8000 --eval 800 --device cpu
python evaluate_clip_heads.py --headset dfmm --model ./clip_attr_dfmm --train 16000 --eval 1500 --device cpu
# Separate annotation path (not a reproduction of the shipped HF checkpoint):
python evaluate_clip_heads.py --headset dfmm-local --model /path/to/local-trained-heads --source /path/to/DFMM --eval 200 --device cpu
python -m unittest discover -s tests
```

These explicit example slices are not verified training splits. Training overlap
is unknown. The evaluator resolves the HF revision to a commit (`--dataset-revision`
can pin it), follows the trainer's row ordering and fallbacks, and retains only the
requested HF tail. It refuses short HF collections rather than silently shifting
the slice. Forward passes are batched (`--batch-size`, default 16).

`--out` defaults to `results/<headset>`. Outputs are `metrics.json`,
`provenance.json`, one complete per-class CSV and one confusion PNG per attribute.
The fingerprint hashes each selected row's labels, image dimensions and RGB pixels
in order; it is not a claim that these images were absent from training.

Fashion macro-F1 includes every checkpoint class, even absent formality classes.
HF DFMM masks unknown ground truth separately per head, but predictions of unknown
are errors. Its macro-F1 includes all non-unknown classes, even zero-support ones.
Every class, including unknown, remains in CSVs/matrices. Local DFMM follows its
own trainer's unmasked labels. `n_classes` is the full checkpoint vocabulary size;
the provenance records macro labels, excluded counts and index-fallback counts.
No eligible examples yields JSON null scores and zero support, not fabricated 0%
accuracy. These are proxy/caption labels and local-head metrics, not independently
human-labelled garment quality or full upload-pipeline performance.
