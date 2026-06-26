"""Inference endpoint for the fine-tuned BLIP-2 captioner.

Deploy this (Colab/RunPod/HF endpoint) and put its URL in BLIP2_ENDPOINT_URL so
the backend's blip2_client posts garment images here and gets the item-attribute
JSON straight through (docs/wardrobe/01_api_contract.md §2).

  POST /            multipart field "image"  -> { ...item attributes... }
  GET  /health      -> { status }

The model predicts the six visually-grounded fields (attributes.TARGET_FIELDS);
this server adds pixel-derived colors and rule-derived category/warmth/seasons via
attributes.to_full_item_attributes, so the output matches what the app expects.
Auth: if BLIP2_ENDPOINT_TOKEN is set, requests must send a matching Bearer token.
"""
from __future__ import annotations

import io
import os
from collections import Counter

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from PIL import Image

import attributes as attr

BASE_MODEL = os.environ.get("BLIP2_BASE_MODEL", "Salesforce/blip2-opt-2.7b")
ADAPTER_DIR = os.environ.get("BLIP2_ADAPTER_DIR", "./adapter")  # LoRA weights
TOKEN = os.environ.get("BLIP2_ENDPOINT_TOKEN", "")
PROMPT = "Describe this garment as JSON with keys subcategory, fabric, formality, neckline, sleeveLength, pattern."

app = FastAPI(title="blip2_captioner")
_model = None
_processor = None


def _load():
    """Lazy-loads BLIP-2 + the LoRA adapter (heavy; kept out of import/health)."""
    global _model, _processor
    if _model is not None:
        return
    import torch
    from peft import PeftModel
    from transformers import Blip2ForConditionalGeneration, Blip2Processor

    _processor = Blip2Processor.from_pretrained(BASE_MODEL)
    base = Blip2ForConditionalGeneration.from_pretrained(
        BASE_MODEL, torch_dtype=torch.float16
    )
    model = PeftModel.from_pretrained(base, ADAPTER_DIR) if os.path.isdir(ADAPTER_DIR) else base
    _model = model.to("cuda" if torch.cuda.is_available() else "cpu").eval()


def _dominant_colors(img: Image.Image):
    """Pixel-derived primary + secondary colors as #RRGGBB (no ML).

    Operates on RGBA so background-removed (transparent) pixels and near-white
    studio padding are ignored — otherwise the removed background (which becomes
    black when flattened to RGB) would dominate and every garment would read as
    black. Falls back to None when nothing opaque remains.
    """
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
    primary = to_hex(counts[0][0])
    secondary = [to_hex(c) for c, _ in counts[1:]]
    return {"primaryColor": primary, "secondaryColors": secondary}


@app.get("/health")
def health():
    return {"status": "ok", "base_model": BASE_MODEL, "adapter_loaded": os.path.isdir(ADAPTER_DIR)}


@app.post("/")
async def caption(image: UploadFile = File(...), authorization: str = Header(default="")):
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="invalid token")

    data = await image.read()
    try:
        img = Image.open(io.BytesIO(data))  # keep alpha if present (nobg PNG)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid image")

    # Colours from the original (alpha-aware); the model needs flat RGB.
    colors = _dominant_colors(img)
    rgb = img.convert("RGB")

    try:
        _load()
        import torch

        inputs = _processor(images=rgb, text=PROMPT, return_tensors="pt").to(_model.device)
        with torch.no_grad():
            out = _model.generate(**inputs, max_new_tokens=128)
        text = _processor.batch_decode(out, skip_special_tokens=True)[0]
        model_json = attr.parse_model_json(text)
    except Exception as exc:  # model not deployed yet / inference failure
        # Still return a usable (color-only) response rather than 500.
        model_json = {}
        print("[blip2 serve] inference unavailable:", exc)

    return attr.to_full_item_attributes(model_json, colors)
