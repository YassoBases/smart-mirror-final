"""Trains the garment-identity projection head (identity_head.py) so that
different photos of the SAME physical garment land close together in the
projected embedding space, and different garments land apart.

Data convention — one folder per physical garment, 3-5 photos each, from
different angles, directly under --data:

    identity_data/
      navy_hoodie/
        front.jpg
        side.jpg
        back.jpg
      blue_jeans/
        01.jpg
        02.jpg
        03.jpg
        04.jpg
      ... (10-15 garments total)

Each photo is passed through bg_remover (if BG_REMOVER_URL is set/reachable —
same sidecar the upload pipeline uses) before CLIP encoding, matching what the
service embeds at enrollment/recognition time (the background-removed image,
not the raw photo). If the sidecar is unreachable, the raw photo is used
instead and this is printed plainly, since it changes what's actually being
compared.

Protocol: one photo per garment is held out as a test query; the rest form
that garment's gallery. Reports top-1 retrieval accuracy — nearest gallery
garment (by mean embedding) to each held-out query — for the frozen-CLIP
baseline and for the trained projection, exactly as they come out.

Usage:
  python train_identity_head.py --data ./identity_data --out ./clip_identity_head
"""
from __future__ import annotations

import argparse
import io
import os
import random
from pathlib import Path
from typing import Dict, List

import torch
import torch.nn.functional as F
from PIL import Image

from clip_heads import ClipAttr
from identity_head import IdentityHead

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def remove_background(image: Image.Image, bg_remover_url: str | None) -> Image.Image:
    """Best-effort: falls back to the raw photo if the sidecar isn't reachable."""
    if not bg_remover_url:
        return image
    try:
        import urllib.request

        buf = io.BytesIO()
        image.convert("RGB").save(buf, "JPEG")
        boundary = "identity-train-boundary"
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"item.jpg\"\r\n"
            f"Content-Type: image/jpeg\r\n\r\n"
        ).encode() + buf.getvalue() + f"\r\n--{boundary}--\r\n".encode()
        req = urllib.request.Request(
            f"{bg_remover_url.rstrip('/')}/remove", data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return Image.open(io.BytesIO(resp.read())).convert("RGB")
    except Exception as err:
        print(f"    (bg removal unavailable, using raw photo: {err})")
        return image


def load_dataset(data_dir: Path, bg_remover_url: str | None) -> Dict[str, List[Image.Image]]:
    garments: Dict[str, List[Image.Image]] = {}
    for garment_dir in sorted(p for p in data_dir.iterdir() if p.is_dir()):
        photos = sorted(p for p in garment_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS)
        if len(photos) < 2:
            print(f"  skipping {garment_dir.name}: needs >=2 photos, found {len(photos)}")
            continue
        print(f"  {garment_dir.name}: {len(photos)} photo(s)")
        images = []
        for p in photos:
            img = Image.open(p).convert("RGB")
            images.append(remove_background(img, bg_remover_url))
        garments[garment_dir.name] = images
    return garments


def split_train_test(garments: Dict[str, List[Image.Image]], seed: int):
    """One held-out query photo per garment; the rest are that garment's gallery."""
    rng = random.Random(seed)
    train, test = {}, {}
    for name, images in garments.items():
        images = list(images)
        rng.shuffle(images)
        test[name] = images[0]
        train[name] = images[1:]
    return train, test


@torch.no_grad()
def embed_all(model: ClipAttr, images: List[Image.Image], batch: int = 16) -> torch.Tensor:
    feats = []
    for i in range(0, len(images), batch):
        feats.append(model.features(images[i : i + batch]))
    return torch.cat(feats, dim=0)


def top1_accuracy(train_embeds: Dict[str, torch.Tensor], test_embeds: Dict[str, torch.Tensor]) -> tuple[float, list]:
    """Nearest gallery-garment (by mean embedding) to each held-out query."""
    names = list(train_embeds.keys())
    galleries = torch.stack([train_embeds[n].mean(dim=0) for n in names])  # already-normalized embeds -> mean then renorm
    galleries = F.normalize(galleries, dim=-1)
    correct, rows = 0, []
    for true_name, query in test_embeds.items():
        sims = galleries @ F.normalize(query, dim=-1)
        pred_name = names[int(sims.argmax())]
        hit = pred_name == true_name
        correct += int(hit)
        rows.append((true_name, pred_name, float(sims.max()), hit))
    return correct / len(test_embeds), rows


def build_triplets(train_embeds: Dict[str, torch.Tensor], rng: random.Random):
    """Every (anchor, positive) pair within a garment, each with one random
    negative from a different garment. Exhaustive — datasets here are tiny."""
    names = list(train_embeds.keys())
    triplets = []
    for name in names:
        embeds = train_embeds[name]
        others = [n for n in names if n != name]
        if not others or embeds.shape[0] < 2:
            continue
        for i in range(embeds.shape[0]):
            for j in range(embeds.shape[0]):
                if i == j:
                    continue
                neg_name = rng.choice(others)
                neg_pool = train_embeds[neg_name]
                neg = neg_pool[rng.randrange(neg_pool.shape[0])]
                triplets.append((embeds[i], embeds[j], neg))
    return triplets


def train_head(train_embeds: Dict[str, torch.Tensor], epochs: int, lr: float, margin: float, seed: int) -> IdentityHead:
    rng = random.Random(seed)
    head = IdentityHead()
    opt = torch.optim.AdamW(head.parameters(), lr=lr, weight_decay=1e-4)
    for epoch in range(epochs):
        triplets = build_triplets(train_embeds, rng)
        rng.shuffle(triplets)
        anchors = torch.stack([t[0] for t in triplets])
        positives = torch.stack([t[1] for t in triplets])
        negatives = torch.stack([t[2] for t in triplets])
        opt.zero_grad()
        pa, pp, pn = head(anchors), head(positives), head(negatives)
        pos_sim = F.cosine_similarity(pa, pp)
        neg_sim = F.cosine_similarity(pa, pn)
        loss = F.relu(margin - pos_sim + neg_sim).mean()
        loss.backward()
        opt.step()
        if epoch % max(1, epochs // 10) == 0 or epoch == epochs - 1:
            print(f"  epoch {epoch:3d}  loss {loss.item():.4f}  mean pos-sim {pos_sim.mean().item():.3f}  mean neg-sim {neg_sim.mean().item():.3f}")
    head.eval()
    return head


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="./identity_data")
    ap.add_argument("--out", default="./clip_identity_head")
    ap.add_argument("--epochs", type=int, default=300)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--margin", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--bg-remover-url", default=os.environ.get("BG_REMOVER_URL", ""))
    args = ap.parse_args()

    data_dir = Path(args.data)
    if not data_dir.is_dir():
        raise SystemExit(f"No such data directory: {data_dir}")

    print(f"Loading garments from {data_dir} (bg_remover: {args.bg_remover_url or 'disabled — using raw photos'})")
    garments = load_dataset(data_dir, args.bg_remover_url or None)
    if len(garments) < 2:
        raise SystemExit(
            f"Found {len(garments)} usable garment folder(s) (need >=2, each with >=2 photos) — "
            f"nothing to train or evaluate on yet. Drop photos into {data_dir}/<garment_name>/ and re-run."
        )

    train_images, test_images = split_train_test(garments, args.seed)

    print("Loading frozen CLIP (openai/clip-vit-base-patch32)...")
    model = ClipAttr(device="cpu")

    print("Embedding gallery (train) photos...")
    train_embeds = {name: embed_all(model, imgs) for name, imgs in train_images.items()}
    print("Embedding held-out query photos...")
    test_embeds = {name: embed_all(model, [img])[0] for name, img in test_images.items()}

    baseline_acc, baseline_rows = top1_accuracy(train_embeds, test_embeds)

    print(f"\nTraining identity head on {sum(e.shape[0] for e in train_embeds.values())} gallery embeddings "
          f"across {len(train_embeds)} garments...")
    head = train_head(train_embeds, args.epochs, args.lr, args.margin, args.seed)

    with torch.no_grad():
        projected_train = {name: head(embeds) for name, embeds in train_embeds.items()}
        projected_test = {name: head(embed.unsqueeze(0))[0] for name, embed in test_embeds.items()}
    trained_acc, trained_rows = top1_accuracy(projected_train, projected_test)

    head.save(args.out)

    n = len(test_embeds)
    print("\n" + "=" * 60)
    print(f"Garment identity retrieval — {n} garments, 1 held-out query photo each")
    print("=" * 60)
    print(f"{'method':<24}{'top-1 accuracy':<18}{'correct/total'}")
    print(f"{'baseline (frozen CLIP)':<24}{baseline_acc:<18.3f}{sum(r[3] for r in baseline_rows)}/{n}")
    print(f"{'trained (projection)':<24}{trained_acc:<18.3f}{sum(r[3] for r in trained_rows)}/{n}")
    print("=" * 60)
    if trained_acc <= baseline_acc:
        print(
            "NOTE: the trained projection did not beat the frozen-CLIP baseline on this "
            "run. Reporting both numbers as they came out — not adjusting the split or "
            "threshold to manufacture a better result. With this few photos per garment, "
            "that outcome is plausible; more photos per garment is the first thing to try."
        )
    print(f"\nSaved identity head to {args.out}/ (head.pt, config.json)")


if __name__ == "__main__":
    main()
