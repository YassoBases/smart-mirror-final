"""Frozen CLIP image encoder + small per-attribute classification heads.

Shared by train_clip_heads.py (training) and serve_clip.py (serving). The CLIP
vision encoder is frozen; only one linear head per attribute is trained. Fits a
6 GB GPU easily and gives deterministic per-attribute predictions that map onto
the API item shape (docs/wardrobe/01_api_contract.md §2).
"""
from __future__ import annotations

import json
import os
from typing import Dict, List

import torch
import torch.nn as nn
from transformers import CLIPProcessor, CLIPVisionModelWithProjection

CLIP_MODEL = "openai/clip-vit-base-patch32"
FEAT_DIM = 512  # projection dim of ViT-B/32


class AttrHeads(nn.Module):
    def __init__(self, feat_dim: int, head_sizes: Dict[str, int], hidden: int = 0, dropout: float = 0.1):
        super().__init__()

        def make(n):
            if hidden > 0:
                return nn.Sequential(
                    nn.Linear(feat_dim, hidden), nn.GELU(), nn.Dropout(dropout), nn.Linear(hidden, n)
                )
            return nn.Linear(feat_dim, n)

        self.heads = nn.ModuleDict({k: make(n) for k, n in head_sizes.items()})

    def forward(self, feats):
        return {k: h(feats) for k, h in self.heads.items()}


class ClipAttr:
    def __init__(self, device: str = "cpu"):
        self.device = device
        self.clip = CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, use_safetensors=True).to(device).eval()
        for p in self.clip.parameters():
            p.requires_grad_(False)
        self.processor = CLIPProcessor.from_pretrained(CLIP_MODEL)
        self.heads: AttrHeads | None = None
        self.label_maps: Dict[str, List[str]] = {}
        self.hidden = 0

    def build_heads(self, label_maps: Dict[str, List[str]], hidden: int = 0):
        self.label_maps = label_maps
        self.hidden = hidden
        self.heads = AttrHeads(FEAT_DIM, {k: len(v) for k, v in label_maps.items()}, hidden=hidden).to(self.device)

    @torch.no_grad()
    def features(self, images):
        inp = self.processor(images=images, return_tensors="pt").to(self.device)
        f = self.clip(**inp).image_embeds  # (B, 512) projected embedding
        return f / f.norm(dim=-1, keepdim=True)

    def predict(self, image) -> Dict[str, str]:
        f = self.features([image])
        logits = self.heads(f)
        out = {}
        for k, lg in logits.items():
            out[k] = self.label_maps[k][int(lg.argmax(-1).item())]
        return out

    def save(self, d: str):
        os.makedirs(d, exist_ok=True)
        torch.save(self.heads.state_dict(), os.path.join(d, "heads.pt"))
        json.dump(self.label_maps, open(os.path.join(d, "label_maps.json"), "w"))
        json.dump({"hidden": self.hidden}, open(os.path.join(d, "config.json"), "w"))

    def load_heads(self, d: str):
        self.label_maps = json.load(open(os.path.join(d, "label_maps.json")))
        cfg_path = os.path.join(d, "config.json")
        hidden = json.load(open(cfg_path)).get("hidden", 0) if os.path.exists(cfg_path) else 0
        self.build_heads(self.label_maps, hidden=hidden)
        state = torch.load(os.path.join(d, "heads.pt"), map_location=self.device)
        self.heads.load_state_dict(state)
        self.heads.eval()

    # ── Serving: ensemble multiple head-sets over the one shared CLIP encoder ──

    def load_head_set(self, d: str):
        """Loads a head-set without overwriting self.heads. Returns (AttrHeads, label_maps)."""
        lm = json.load(open(os.path.join(d, "label_maps.json")))
        cfg_path = os.path.join(d, "config.json")
        hidden = json.load(open(cfg_path)).get("hidden", 0) if os.path.exists(cfg_path) else 0
        h = AttrHeads(FEAT_DIM, {k: len(v) for k, v in lm.items()}, hidden=hidden).to(self.device)
        h.load_state_dict(torch.load(os.path.join(d, "heads.pt"), map_location=self.device))
        h.eval()
        return h, lm

    @torch.no_grad()
    def predict_multi(self, image, sets):
        """Runs CLIP once, applies every head-set, merges (later sets win per head)."""
        f = self.features([image])
        out = {}
        for h, lm in sets:
            for k, lg in h(f).items():
                out[k] = lm[k][int(lg.argmax(-1).item())]
        return out
