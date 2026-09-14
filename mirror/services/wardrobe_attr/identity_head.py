"""Garment identity projection head — maps a frozen-CLIP embedding to a space
where multiple photos of the SAME physical garment land close together and
different garments land apart. Shared by train_identity_head.py (training) and
serve_clip.py (serving), the same split clip_heads.py uses for attribute heads.

The CLIP encoder itself is never touched — this head is a small MLP trained on
precomputed 512-dim CLIP embeddings (see ClipAttr.features in clip_heads.py),
not on raw images, so training is a short CPU loop over a few hundred vectors.
"""
from __future__ import annotations

import json
import os

import torch
import torch.nn as nn

IN_DIM = 512  # ClipAttr.features() output dim (CLIP ViT-B/32 projection)


class IdentityHead(nn.Module):
    """Linear -> GELU -> Linear, L2-normalized output. Small on purpose: the
    training set is a few dozen photos, not a few thousand."""

    def __init__(self, in_dim: int = IN_DIM, hidden: int = 256, out_dim: int = 128):
        super().__init__()
        self.in_dim, self.hidden, self.out_dim = in_dim, hidden, out_dim
        self.net = nn.Sequential(
            nn.Linear(in_dim, hidden), nn.GELU(), nn.Linear(hidden, out_dim)
        )

    def forward(self, x):
        out = self.net(x)
        return out / out.norm(dim=-1, keepdim=True).clamp_min(1e-8)

    def save(self, d: str):
        os.makedirs(d, exist_ok=True)
        torch.save(self.state_dict(), os.path.join(d, "head.pt"))
        json.dump(
            {"in_dim": self.in_dim, "hidden": self.hidden, "out_dim": self.out_dim},
            open(os.path.join(d, "config.json"), "w"),
        )

    @classmethod
    def load(cls, d: str, device: str = "cpu") -> "IdentityHead":
        cfg = json.load(open(os.path.join(d, "config.json")))
        head = cls(cfg["in_dim"], cfg["hidden"], cfg["out_dim"]).to(device)
        head.load_state_dict(torch.load(os.path.join(d, "head.pt"), map_location=device))
        head.eval()
        return head
