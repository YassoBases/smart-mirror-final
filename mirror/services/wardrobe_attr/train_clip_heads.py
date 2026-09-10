"""Train per-attribute classification heads on a frozen CLIP encoder — local GPU.

Trains heads for the attributes the auto-downloadable `ashraq/fashion-product-
images-small` dataset actually labels: category, subcategory (articleType), and a
formality proxy (from usage). Pattern/fabric/neckline/sleeve are not labeled in
this dataset — they keep rule/default values at serve time (DeepFashion-MultiModal,
prepared via dataset_prep.py, supplies those and the same head architecture
extends to them).

  python train_clip_heads.py --train 2500 --eval 400 --epochs 8 --out ./clip_attr_model
"""
from __future__ import annotations

import argparse
import itertools
from collections import Counter

import torch
import torch.nn as nn
from datasets import load_dataset

from clip_heads import ClipAttr

CATEGORIES = ["top", "bottom", "outerwear", "footwear", "accessory"]
OUTERWEAR_TYPES = {"Jackets", "Sweaters", "Sweatshirts", "Blazers", "Coats", "Waistcoat", "Nehru Jackets", "Rain Jacket"}
FORMALITY = {"Formal": "4", "Smart Casual": "3", "Casual": "2", "Sports": "1", "Ethnic": "3", "Travel": "2", "Party": "4"}


def to_category(master, sub, article):
    if master == "Footwear":
        return "footwear"
    if master == "Accessories":
        return "accessory"
    if sub == "Bottomwear":
        return "bottom"
    if article in OUTERWEAR_TYPES:
        return "outerwear"
    if sub == "Topwear":
        return "top"
    return None  # skip ambiguous (Dress, Innerwear, …)


def collect(n):
    ds = load_dataset("ashraq/fashion-product-images-small", split="train", streaming=True)
    rows = []
    for ex in itertools.islice(ds, n * 2):  # over-pull; some get filtered
        cat = to_category(ex.get("masterCategory"), ex.get("subCategory"), ex.get("articleType"))
        if not cat or not ex.get("articleType"):
            continue
        rows.append({
            "image": ex["image"].convert("RGB"),
            "category": cat,
            "subcategory": ex["articleType"].lower(),
            "formality": FORMALITY.get(ex.get("usage"), "3"),
        })
        if len(rows) >= n:
            break
    return rows


def build_label_maps(rows, top_subcats=30):
    sub_counts = Counter(r["subcategory"] for r in rows)
    top = [s for s, _ in sub_counts.most_common(top_subcats)]
    sub_vocab = top + ["other"]
    return {
        "category": CATEGORIES,
        "subcategory": sub_vocab,
        "formality": ["1", "2", "3", "4", "5"],
    }


def encode_all(model, rows, batch=64):
    feats = []
    for i in range(0, len(rows), batch):
        imgs = [r["image"] for r in rows[i : i + batch]]
        feats.append(model.features(imgs).cpu())
    return torch.cat(feats)


def label_tensor(rows, label_maps, head):
    idx = {l: i for i, l in enumerate(label_maps[head])}
    other = idx.get("other")
    return torch.tensor([idx.get(r[head], other if other is not None else 0) for r in rows])


def accuracy(pred_idx, gold_idx):
    return (pred_idx == gold_idx).float().mean().item()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=int, default=2500)
    ap.add_argument("--eval", type=int, default=400)
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--hidden", type=int, default=256, help="head hidden dim (0 = linear)")
    ap.add_argument("--subcats", type=int, default=40, help="number of subcategory classes")
    ap.add_argument("--out", default="./clip_attr_model")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device != "cuda":
        raise SystemExit("No CUDA GPU — per the request, not training on CPU.")
    print(f"Device: {torch.cuda.get_device_name(0)}")

    rows = collect(args.train + args.eval)
    train_rows, eval_rows = rows[: -args.eval], rows[-args.eval :]
    print(f"Usable samples: {len(train_rows)} train / {len(eval_rows)} eval")

    model = ClipAttr(device=device)
    label_maps = build_label_maps(train_rows, top_subcats=args.subcats)
    model.build_heads(label_maps, hidden=args.hidden)
    heads = label_maps.keys()

    print("Encoding images with frozen CLIP…")
    Xtr = encode_all(model, train_rows).to(device)
    Xte = encode_all(model, eval_rows).to(device)
    Ytr = {h: label_tensor(train_rows, label_maps, h).to(device) for h in heads}
    Yte = {h: label_tensor(eval_rows, label_maps, h).to(device) for h in heads}

    # Majority-class baseline (the "before" numbers).
    print("\n=== majority-class baseline (before) ===")
    base_acc = {}
    for h in heads:
        maj = torch.mode(Ytr[h]).values
        base_acc[h] = accuracy(torch.full_like(Yte[h], maj.item()), Yte[h])
        print(f"  {h:<12} {base_acc[h]*100:5.1f}%")

    opt = torch.optim.AdamW(model.heads.parameters(), lr=1e-3, weight_decay=1e-4)
    ce = nn.CrossEntropyLoss()
    bs = 256
    for epoch in range(args.epochs):
        model.heads.train()
        perm = torch.randperm(len(Xtr), device=device)
        for i in range(0, len(Xtr), bs):
            b = perm[i : i + bs]
            logits = model.heads(Xtr[b])
            loss = sum(ce(logits[h], Ytr[h][b]) for h in heads)
            opt.zero_grad(); loss.backward(); opt.step()

    print("\n=== trained heads (after) ===")
    model.heads.eval()
    with torch.no_grad():
        logits = model.heads(Xte)
    for h in heads:
        acc = accuracy(logits[h].argmax(-1), Yte[h])
        print(f"  {h:<12} {base_acc[h]*100:5.1f}%  ->  {acc*100:5.1f}%")

    model.save(args.out)
    print(f"\nSaved model -> {args.out}")
    print(f"Peak VRAM: {torch.cuda.max_memory_allocated()/1e9:.2f} GB on {torch.cuda.get_device_name(0)}")


if __name__ == "__main__":
    main()
