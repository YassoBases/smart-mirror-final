"""Train pattern / fabric / sleeveLength / neckline heads from DeepFashion-MultiModal.

DFMM is a manual download (images + labels/ txts on Google Drive) — point --source
at its root. Reuses dataset_prep.py's label encodings and the CLIP-heads
architecture, and saves a head-set you ensemble with the category/subcategory
model at serve time:

  python train_clip_heads_dfmm.py --source /data/DeepFashion-MultiModal --out ./clip_attr_dfmm
  # then serve both: BLIP2_MODEL_DIR="./clip_attr_model,./clip_attr_dfmm" uvicorn serve_clip:app ...

Trains the attributes DFMM labels (pattern, fabric, sleeveLength, neckline);
missing labels fall into an 'unknown' class.
"""
from __future__ import annotations

import argparse
import os

import torch
import torch.nn as nn
from PIL import Image

import dataset_prep as dp
from clip_heads import ClipAttr

UNKNOWN = "unknown"


def _label(table, fname, col, mapping):
    try:
        v = mapping.get(int(table.get(fname, [])[col]))
    except (IndexError, ValueError):
        v = None
    return v or UNKNOWN


def build_rows(source):
    img_dir = os.path.join(source, "images")
    shape = dp._read_space_table(os.path.join(source, "labels", "shape", "shape_anno_all.txt"))
    fabric_t = dp._read_space_table(os.path.join(source, "labels", "texture", "fabric_ann.txt"))
    pattern_t = dp._read_space_table(os.path.join(source, "labels", "texture", "pattern_ann.txt"))
    if not shape:
        raise SystemExit(f"No DFMM annotations under {source}/labels/. Download DeepFashion-MultiModal first.")

    rows = []
    for fname, vals in shape.items():
        path = os.path.join(img_dir, fname)
        if not os.path.exists(path):
            continue
        sleeve = dp.SLEEVE.get(int(vals[dp.SHAPE_SLEEVE_IDX])) if len(vals) > dp.SHAPE_SLEEVE_IDX else None
        neck = dp.NECKLINE.get(int(vals[dp.SHAPE_NECKLINE_IDX])) if len(vals) > dp.SHAPE_NECKLINE_IDX else None
        rows.append({
            "image": Image.open(path).convert("RGB"),
            "pattern": _label(pattern_t, fname, 0, dp.PATTERN),
            "fabric": _label(fabric_t, fname, 0, dp.FABRIC),
            "sleeveLength": sleeve or UNKNOWN,
            "neckline": neck or UNKNOWN,
        })
    return rows


def label_maps_from(rows, heads):
    return {h: sorted({r[h] for r in rows}) for h in heads}


def encode_all(model, rows, batch=64):
    feats = []
    for i in range(0, len(rows), batch):
        feats.append(model.features([r["image"] for r in rows[i : i + batch]]).cpu())
    return torch.cat(feats)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="DeepFashion-MultiModal root")
    ap.add_argument("--eval", type=int, default=200)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--hidden", type=int, default=256)
    ap.add_argument("--out", default="./clip_attr_dfmm")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device != "cuda":
        raise SystemExit("No CUDA GPU — per the request, not training on CPU.")
    print(f"Device: {torch.cuda.get_device_name(0)}")

    rows = build_rows(args.source)
    print(f"Built {len(rows)} DFMM samples")
    ev = min(args.eval, len(rows) // 5)
    train_rows, eval_rows = rows[:-ev], rows[-ev:]

    heads = ["pattern", "fabric", "sleeveLength", "neckline"]
    label_maps = label_maps_from(train_rows, heads)
    for h in heads:
        print(f"  {h}: {label_maps[h]}")

    model = ClipAttr(device=device)
    model.build_heads(label_maps, hidden=args.hidden)

    print("Encoding images with frozen CLIP…")
    Xtr = encode_all(model, train_rows).to(device)
    Xte = encode_all(model, eval_rows).to(device)
    idx = {h: {l: i for i, l in enumerate(label_maps[h])} for h in heads}
    Ytr = {h: torch.tensor([idx[h].get(r[h], 0) for r in train_rows]).to(device) for h in heads}
    Yte = {h: torch.tensor([idx[h].get(r[h], 0) for r in eval_rows]).to(device) for h in heads}

    base = {}
    for h in heads:
        maj = torch.mode(Ytr[h]).values.item()
        base[h] = (Yte[h] == maj).float().mean().item()

    opt = torch.optim.AdamW(model.heads.parameters(), lr=1e-3, weight_decay=1e-4)
    ce = nn.CrossEntropyLoss()
    bs = 128
    for _ in range(args.epochs):
        model.heads.train()
        perm = torch.randperm(len(Xtr), device=device)
        for i in range(0, len(Xtr), bs):
            b = perm[i : i + bs]
            logits = model.heads(Xtr[b])
            loss = sum(ce(logits[h], Ytr[h][b]) for h in heads)
            opt.zero_grad(); loss.backward(); opt.step()

    print("\n=== per-attribute accuracy (baseline -> trained) ===")
    model.heads.eval()
    with torch.no_grad():
        logits = model.heads(Xte)
    for h in heads:
        acc = (logits[h].argmax(-1) == Yte[h]).float().mean().item()
        print(f"  {h:<13} {base[h]*100:5.1f}%  ->  {acc*100:5.1f}%")

    model.save(args.out)
    print(f"\nSaved -> {args.out}  | peak VRAM {torch.cuda.max_memory_allocated()/1e9:.2f} GB")


if __name__ == "__main__":
    main()
