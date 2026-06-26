"""Train pattern/fabric/sleeve/neckline heads on REAL DeepFashion-MultiModal images.

Uses the auto-downloadable HF mirror `milica-vas/deepfashion-multimodal`, whose
per-image textual descriptions state the attributes (e.g. "its fabric is cotton,
and it has pure color patterns"). Labels are parsed from the caption for the
*upper* garment; images are the embedded DFMM photos. No Google-Drive download.

  python train_clip_heads_dfmm_hf.py --train 6000 --eval 600 --out ./clip_attr_dfmm
  # serve ensembled with the category model:
  BLIP2_MODEL_DIR="./clip_attr_model,./clip_attr_dfmm" uvicorn serve_clip:app --port 8003

(train_clip_heads_dfmm.py is the equivalent for a local DFMM txt-annotation download.)
"""
from __future__ import annotations

import argparse
import itertools
import os

import torch
import torch.nn as nn
from datasets import load_dataset

from clip_heads import ClipAttr

HEADS = ["pattern", "fabric", "sleeveLength", "neckline"]
UNKNOWN = "unknown"
LOWER_MARKERS = [" pants", " trousers", " shorts", " skirt", " outer clothing", " three-point"]


def parse_attrs(text: str) -> dict:
    t = (text or "").lower()
    idxs = [t.find(m) for m in LOWER_MARKERS if t.find(m) >= 0]
    upper = t[: min(idxs)] if idxs else t  # upper-garment portion only

    fabric = None
    for f in ["denim", "leather", "furry", "knitting", "knitted", "chiffon", "cotton"]:
        if f in upper:
            fabric = "knitted" if f == "knitting" else f
            break

    if "pure color" in upper or "solid" in upper:
        pattern = "solid"
    elif "stripe" in upper:
        pattern = "stripe"
    elif "lattice" in upper or "plaid" in upper or "check" in upper:
        pattern = "plaid"
    elif "graphic" in upper or "floral" in upper or "print" in upper:
        pattern = "print"
    elif "color block" in upper:
        pattern = "other"
    else:
        pattern = None

    if any(s in upper for s in ["sleeveless", "no sleeve", "sleeves cut off", "without sleeve"]):
        sleeve = "sleeveless"
    elif "long-sleeve" in upper or "long sleeve" in upper:
        sleeve = "long-sleeve"
    elif "short-sleeve" in upper or "short sleeve" in upper:
        sleeve = "short-sleeve"
    elif "medium-sleeve" in upper or "medium sleeve" in upper:
        sleeve = "medium-sleeve"
    else:
        sleeve = None

    if "v-shape" in upper or "v-neck" in upper:
        neck = "v-neck"
    elif "lapel" in upper:
        neck = "lapel"
    elif "suspender" in upper:
        neck = "suspenders"
    elif "square" in upper:
        neck = "square"
    elif "stand" in upper:
        neck = "standing"
    elif "crew" in upper or "round" in upper:
        neck = "round"
    else:
        neck = None

    return {"pattern": pattern or UNKNOWN, "fabric": fabric or UNKNOWN,
            "sleeveLength": sleeve or UNKNOWN, "neckline": neck or UNKNOWN}


def collect(n):
    ds = load_dataset("milica-vas/deepfashion-multimodal", split="train", streaming=True)
    rows = []
    for ex in itertools.islice(ds, n):
        a = parse_attrs(ex["text"])
        a["image"] = ex["image"].convert("RGB")
        rows.append(a)
    return rows


def encode_all(model, rows, batch=64):
    feats = []
    for i in range(0, len(rows), batch):
        feats.append(model.features([r["image"] for r in rows[i : i + batch]]).cpu())
    return torch.cat(feats)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=int, default=16000)
    ap.add_argument("--eval", type=int, default=1500)
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--hidden", type=int, default=256)
    ap.add_argument("--weight", choices=["none", "sqrt", "inv"], default="none",
                    help="class weighting for imbalanced heads (none=best overall accuracy)")
    ap.add_argument("--out", default="./clip_attr_dfmm")
    args = ap.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device != "cuda":
        raise SystemExit("No CUDA GPU — per the request, not training on CPU.")
    print(f"Device: {torch.cuda.get_device_name(0)}")

    model = ClipAttr(device=device)

    # CLIP-encode once and cache (encoding 17k images dominates runtime); re-runs
    # with the same --train/--eval reuse the cache so weighting can be tuned fast.
    cache = os.path.join(os.path.dirname(__file__), f"_cache_dfmm_{args.train}_{args.eval}.pt")
    if os.path.exists(cache):
        blob = torch.load(cache, weights_only=False)
        label_maps = blob["label_maps"]
        Xtr, Xte = blob["Xtr"].to(device), blob["Xte"].to(device)
        Ytr = {h: blob["Ytr"][h].to(device) for h in HEADS}
        Yte = {h: blob["Yte"][h].to(device) for h in HEADS}
        print(f"Loaded cached features ({len(Xtr)} train / {len(Xte)} eval)")
    else:
        rows = collect(args.train + args.eval)
        train_rows, eval_rows = rows[: -args.eval], rows[-args.eval :]
        print(f"Loaded {len(train_rows)} train / {len(eval_rows)} eval (real DFMM images)")
        for h in HEADS:
            dist = {}
            for r in train_rows:
                dist[r[h]] = dist.get(r[h], 0) + 1
            print(f"  {h}: {dict(sorted(dist.items(), key=lambda x: -x[1]))}")
        label_maps = {h: sorted({r[h] for r in train_rows}) for h in HEADS}
        print("Encoding images with frozen CLIP…")
        Xtr = encode_all(model, train_rows).to(device)
        Xte = encode_all(model, eval_rows).to(device)
        idx = {h: {l: i for i, l in enumerate(label_maps[h])} for h in HEADS}
        Ytr = {h: torch.tensor([idx[h].get(r[h], 0) for r in train_rows]).to(device) for h in HEADS}
        Yte = {h: torch.tensor([idx[h].get(r[h], 0) for r in eval_rows]).to(device) for h in HEADS}
        torch.save({"label_maps": label_maps, "Xtr": Xtr.cpu(), "Xte": Xte.cpu(),
                    "Ytr": {h: Ytr[h].cpu() for h in HEADS}, "Yte": {h: Yte[h].cpu() for h in HEADS}}, cache)

    model.build_heads(label_maps, hidden=args.hidden)

    # Per-head loss: ignore the parser's 'unknown' (train only on real labels).
    # --weight controls class weighting: none (best overall accuracy on imbalanced
    # heads like fabric), sqrt (mild — lifts rare-class recall with small overall
    # cost), or inv (full inverse-freq — maximizes rare recall, hurts overall).
    unk_idx = {h: (label_maps[h].index(UNKNOWN) if UNKNOWN in label_maps[h] else -100) for h in HEADS}
    losses = {}
    for h in HEADS:
        n = len(label_maps[h])
        counts = torch.bincount(Ytr[h], minlength=n).float()
        if unk_idx[h] >= 0:
            counts[unk_idx[h]] = 0
        w = torch.ones(n, device=device)
        known = counts > 0
        if args.weight != "none":
            raw = counts[known].sum() / counts[known]
            raw = raw.sqrt() if args.weight == "sqrt" else raw
            w = torch.zeros(n, device=device)
            w[known] = raw / raw.mean()  # mean ~1
        losses[h] = nn.CrossEntropyLoss(weight=w, ignore_index=unk_idx[h])

    # Known-only majority baseline + eval mask (predicting 'unknown' isn't meaningful).
    def known_mask(y, h):
        return y != unk_idx[h] if unk_idx[h] >= 0 else torch.ones_like(y, dtype=torch.bool)

    base = {}
    for h in HEADS:
        m = known_mask(Yte[h], h)
        if m.any():
            known_tr = Ytr[h][known_mask(Ytr[h], h)]
            maj = torch.mode(known_tr).values
            base[h] = (Yte[h][m] == maj).float().mean().item()
        else:
            base[h] = 0.0

    opt = torch.optim.AdamW(model.heads.parameters(), lr=1e-3, weight_decay=1e-4)
    bs = 256
    for _ in range(args.epochs):
        model.heads.train()
        perm = torch.randperm(len(Xtr), device=device)
        for i in range(0, len(Xtr), bs):
            b = perm[i : i + bs]
            logits = model.heads(Xtr[b])
            loss = sum(losses[h](logits[h], Ytr[h][b]) for h in HEADS)
            opt.zero_grad(); loss.backward(); opt.step()

    print("\n=== per-attribute accuracy on known labels (majority baseline -> trained) ===")
    model.heads.eval()
    with torch.no_grad():
        logits = model.heads(Xte)
    macro = {}
    for h in HEADS:
        m = known_mask(Yte[h], h)
        pred = logits[h].argmax(-1)
        acc = (pred[m] == Yte[h][m]).float().mean().item() if m.any() else 0.0
        # macro recall = mean per-class recall over classes present in eval
        recalls = []
        for ci, lbl in enumerate(label_maps[h]):
            if lbl == UNKNOWN:
                continue
            cm = Yte[h] == ci
            if cm.any():
                recalls.append((pred[cm] == ci).float().mean().item())
        macro[h] = sum(recalls) / len(recalls) if recalls else 0.0
        print(f"  {h:<13} {base[h]*100:5.1f}%  ->  {acc*100:5.1f}%   macro-recall {macro[h]*100:5.1f}%   (n={int(m.sum())})")

    # Per-class recall for fabric — shows the rare-class trade-off across --weight.
    print(f"\n  fabric per-class recall (weight={args.weight}):")
    pred_f = logits["fabric"].argmax(-1)
    for ci, lbl in enumerate(label_maps["fabric"]):
        if lbl == UNKNOWN:
            continue
        cm = Yte["fabric"] == ci
        if cm.any():
            r = (pred_f[cm] == ci).float().mean().item()
            print(f"     {lbl:<10} {r*100:5.1f}%   (n={int(cm.sum())})")

    model.save(args.out)
    print(f"\nSaved -> {args.out}  | peak VRAM {torch.cuda.max_memory_allocated()/1e9:.2f} GB")


if __name__ == "__main__":
    main()
