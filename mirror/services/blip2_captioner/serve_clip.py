"""Inference endpoint for the LOCAL CLIP-heads attribute model (Option B).

Serves the model trained by train_clip_heads.py with the SAME contract as
serve.py / blip2_client: POST an image, get back the §2 item-attribute shape.
Put this endpoint's URL in BLIP2_ENDPOINT_URL.

  BLIP2_MODEL_DIR=./clip_attr_model uvicorn serve_clip:app --host 0.0.0.0 --port 8003

The CLIP heads predict category, subcategory, and formality; colors come from
pixels; pattern/fabric/warmth/seasons are rule/default (this dataset doesn't
label them — DeepFashion-MultiModal + dataset_prep.py extend the heads to those).
"""
from __future__ import annotations

import io
import os
from collections import Counter

import torch
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from PIL import Image

import attributes as attr
from clip_heads import ClipAttr

# Comma-separated dirs: e.g. "./clip_attr_model,./clip_attr_dfmm" — the first has
# category/subcategory/formality heads, the second adds pattern/fabric/etc. Both
# share one frozen CLIP encoder (loaded once). Defaults to both committed
# head-sets: clip_attr_model (category/subcategory/formality) + clip_attr_dfmm
# (pattern/fabric/sleeve/neckline). Override with BLIP2_MODEL_DIR.
_HERE = os.path.dirname(__file__)
MODEL_DIR = os.environ.get(
    "BLIP2_MODEL_DIR",
    f"{os.path.join(_HERE, 'clip_attr_model')},{os.path.join(_HERE, 'clip_attr_dfmm')}",
)
TOKEN = os.environ.get("BLIP2_ENDPOINT_TOKEN", "")

app = FastAPI(title="blip2_captioner (clip-heads)")
_model = None
_sets = None


def _load():
    global _model, _sets
    if _model is None:
        device = "cuda" if torch.cuda.is_available() else "cpu"
        _model = ClipAttr(device=device)
        # Load each configured head-set that actually exists on disk, so a missing
        # optional set (e.g. clip_attr_dfmm) degrades instead of crashing serving.
        dirs = [d.strip() for d in MODEL_DIR.split(",") if d.strip() and os.path.isdir(d.strip())]
        _sets = [_model.load_head_set(d) for d in dirs]
    return _model, _sets


def _dominant_colors(img: Image.Image):
    """Alpha-aware dominant colours: ignore transparent (background-removed) and
    near-white padding pixels so the garment's real colour wins instead of the
    (black-when-flattened) removed background."""
    rgba = img.convert("RGBA").resize((64, 64))
    pixels = [
        (r, g, b)
        for (r, g, b, a) in rgba.getdata()
        if a >= 128 and not (r > 244 and g > 244 and b > 244)
    ]
    if not pixels:
        return {"primaryColor": None, "secondaryColors": []}
    counts = Counter(pixels).most_common(3)
    to_hex = lambda c: "#{:02X}{:02X}{:02X}".format(*c)
    return {
        "primaryColor": to_hex(counts[0][0]),
        "secondaryColors": [to_hex(c) for c, _ in counts[1:]],
    }


VALID_PATTERNS = {"solid", "stripe", "plaid", "print", "other"}


def _none_if(v, *blanks):
    return None if v in blanks else v


@app.get("/health")
def health():
    dirs = [d.strip() for d in MODEL_DIR.split(",") if d.strip()]
    return {"status": "ok", "model_dirs": dirs, "loaded": all(os.path.isdir(d) for d in dirs)}


@app.post("/")
async def caption(image: UploadFile = File(...), authorization: str = Header(default="")):
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="invalid token")
    data = await image.read()
    try:
        img = Image.open(io.BytesIO(data))  # keep alpha if present (nobg PNG)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid image")

    colors = _dominant_colors(img)  # alpha-aware, before flattening
    rgb = img.convert("RGB")

    model, sets = _load()
    heads = model.predict_multi(rgb, sets)  # merged across head-sets

    category = heads.get("category", "top")
    formality = int(heads.get("formality", "3"))
    sub = _none_if(heads.get("subcategory"), "other")

    # pattern/fabric come from a DFMM-trained head-set when present, else default.
    pattern = heads.get("pattern")
    pattern = pattern if pattern in VALID_PATTERNS else "solid"
    fabric = _none_if(heads.get("fabric"), None, "NA", "unknown")
    warmth = attr.warmth_for(fabric, category)

    tags = [t for t in [sub, _none_if(heads.get("sleeveLength"), "NA", "unknown"),
                        _none_if(heads.get("neckline"), "NA", "unknown")] if t]

    return {
        "category": category,
        "subcategory": sub,
        "primaryColor": colors["primaryColor"],
        "secondaryColors": colors["secondaryColors"],
        "pattern": pattern,
        "fabricGuess": fabric,
        "formality": max(1, min(5, formality)),
        "warmth": warmth,
        "seasons": attr.seasons_for(warmth),
        "tags": tags,
    }
