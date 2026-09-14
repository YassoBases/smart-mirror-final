"""Frozen CLIP encoder plus both committed attribute head-sets.

POST an image to / for the existing wardrobe attribute response contract.
Colors are pixel-derived; warmth/seasons are rules. The backend can optionally
apply a separate OpenAI image-verification pass after these local predictions.
Legacy environment aliases are retained; explicitly set new names take priority.
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
from identity_head import IdentityHead

# Comma-separated dirs: e.g. "./clip_attr_model,./clip_attr_dfmm" — the first has
# category/subcategory/formality heads, the second adds pattern/fabric/etc. Both
# share one frozen CLIP encoder (loaded once). Defaults to both committed
# head-sets: clip_attr_model (category/subcategory/formality) + clip_attr_dfmm
# (pattern/fabric/sleeve/neckline). Override with WARDROBE_ATTR_MODEL_DIR.
_HERE = os.path.dirname(__file__)
MODEL_DIR = os.environ.get(
    "WARDROBE_ATTR_MODEL_DIR",
    os.environ.get("BLIP2_MODEL_DIR",
        f"{os.path.join(_HERE, 'clip_attr_model')},{os.path.join(_HERE, 'clip_attr_dfmm')}"),
)
TOKEN = os.environ.get("WARDROBE_ATTR_ENDPOINT_TOKEN", os.environ.get("BLIP2_ENDPOINT_TOKEN", ""))

# Garment-identity projection head (see identity_head.py / train_identity_head.py).
# Optional: /embed still returns a raw CLIP embedding when this isn't trained yet.
IDENTITY_MODEL_DIR = os.environ.get(
    "WARDROBE_IDENTITY_MODEL_DIR", os.path.join(_HERE, "clip_identity_head")
)

app = FastAPI(title="wardrobe_attr")
_model = None
_sets = None
_identity_head = None
_identity_load_attempted = False


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


def _load_identity_head():
    """Lazy, best-effort: an untrained/missing head means /embed falls back to
    the raw CLIP embedding rather than failing the request."""
    global _identity_head, _identity_load_attempted
    if _identity_load_attempted:
        return _identity_head
    _identity_load_attempted = True
    if os.path.isdir(IDENTITY_MODEL_DIR):
        try:
            _identity_head = IdentityHead.load(IDENTITY_MODEL_DIR)
        except Exception as err:
            print(f"[wardrobe_attr] identity head at {IDENTITY_MODEL_DIR} failed to load: {err}")
    return _identity_head


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
    return {
        "status": "ok",
        "model_dirs": dirs,
        "loaded": all(os.path.isdir(d) for d in dirs),
        "identity_head_trained": os.path.isdir(IDENTITY_MODEL_DIR),
    }


@app.post("/embed")
async def embed(image: UploadFile = File(...), authorization: str = Header(default="")):
    """Garment-identity embedding for recognition (not attribute classification —
    see POST / for that). Returns the SAME shared frozen CLIP encoder's feature,
    passed through the trained identity projection head when one exists.
    Never persists the image; it is decoded, embedded, and discarded."""
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="invalid token")
    data = await image.read()
    try:
        img = Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="invalid image")

    model, _ = _load()
    feat = model.features([img])  # (1, 512), L2-normalized
    head = _load_identity_head()
    projected = head is not None
    if head is not None:
        with torch.no_grad():
            feat = head(feat)
    return {"embedding": feat[0].tolist(), "projected": projected, "dim": feat.shape[-1]}


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
