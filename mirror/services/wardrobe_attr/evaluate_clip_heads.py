"""Evaluate an explicit dataset slice. Historical training overlap is unknown."""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, f1_score
import torch

DATASETS = {"fashion": "ashraq/fashion-product-images-small",
            "dfmm": "milica-vas/deepfashion-multimodal"}
DISCLAIMER = "Evaluation of an explicitly selected slice; historical split reproduction unverified; training overlap unknown."


def positive(value):
    result = int(value)
    if result <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return result


def arguments(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--headset", choices=["fashion", "dfmm", "dfmm-local"], required=True)
    p.add_argument("--model", type=Path, required=True)
    p.add_argument("--train", type=positive)
    p.add_argument("--eval", type=positive, required=True)
    p.add_argument("--source", type=Path)
    p.add_argument("--dataset-revision", help="HF revision, resolved to an immutable commit before collecting")
    p.add_argument("--batch-size", type=positive, default=16)
    p.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    p.add_argument("--out", type=Path)
    args = p.parse_args(argv)
    if args.headset == "dfmm-local":
        if not args.source:
            p.error("--source is required for dfmm-local")
        if args.train or args.dataset_revision:
            p.error("--train and --dataset-revision apply only to HF modes")
    elif not args.train or args.source:
        p.error("HF modes require --train and do not accept --source")
    args.out = args.out or Path("results") / args.headset
    return args


def select_rows(args):
    if args.headset == "dfmm-local":
        from train_clip_heads_dfmm import build_rows
        rows = build_rows(str(args.source))
        ev = min(args.eval, len(rows) // 5)
        if ev < 1:
            raise ValueError("local DFMM needs at least five usable rows for a nonempty evaluation split")
        return rows[-ev:], {"dataset": "local DFMM annotations", "revision": None,
                              "usable_rows": len(rows), "tail_size": ev}
    from huggingface_hub import HfApi
    dataset = DATASETS[args.headset]
    revision = HfApi().dataset_info(dataset, revision=args.dataset_revision).sha
    if args.headset == "fashion":
        from train_clip_heads import collect
    else:
        from train_clip_heads_dfmm_hf import collect
    stats = {}
    rows = collect(args.train + args.eval, revision=revision, keep_last=args.eval, stats=stats)
    if stats["usable_rows"] != args.train + args.eval:
        raise ValueError(f"Requested {args.train + args.eval} usable rows, collected {stats['usable_rows']}; refusing a shifted slice")
    return rows, {"dataset": dataset, "revision": revision, **stats, "tail_size": len(rows)}


def encode_labels(rows, label_maps, mode):
    gold, policies = {}, {}
    for head, names in label_maps.items():
        idx = {name: i for i, name in enumerate(names)}
        fallback = idx.get("other", 0) if mode == "fashion" else 0
        if mode == "fashion":
            from train_clip_heads import label_tensor
            gold[head] = label_tensor(rows, label_maps, head).numpy()
        else:
            gold[head] = np.array([idx.get(r[head], 0) for r in rows], dtype=np.int64)
        policies[head] = {"fallback_count": sum(r[head] not in idx for r in rows),
                          "fallback_index": fallback, "fallback_class": names[fallback]}
    return gold, policies


def score_head(gold, pred, names, known_only=False):
    labels = list(range(len(names)))
    scored = [i for i, name in enumerate(names) if not known_only or name != "unknown"]
    mask = np.array([not known_only or names[int(v)] != "unknown" for v in gold], dtype=bool)
    y, yp = np.asarray(gold)[mask], np.asarray(pred)[mask]
    n = len(y)
    report = (classification_report(y, yp, labels=labels, target_names=names,
                                    zero_division=0, output_dict=True) if n else
              {name: {"precision": 0.0, "recall": 0.0, "f1-score": 0.0, "support": 0}
               for name in names})
    matrix = confusion_matrix(y, yp, labels=labels) if n else np.zeros((len(names), len(names)), dtype=int)
    metrics = {"accuracy": float(accuracy_score(y, yp)) if n else None,
               "macro_f1": float(f1_score(y, yp, labels=scored, average="macro", zero_division=0)) if n and scored else None,
               "n": n, "n_classes": len(names)}
    policy = {"eligible": n, "excluded": int(len(gold)-n),
              "macro_labels": [names[i] for i in scored], "known_ground_truth_only": known_only}
    return metrics, report, matrix, policy


def save_head(out, head, names, report, matrix):
    if not head.replace("_", "").isalnum():
        raise ValueError(f"unsafe attribute filename: {head!r}")
    with (out / f"per_class_{head}.csv").open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["class", "precision", "recall", "f1", "support"])
        for name in names:
            r = report[name]
            writer.writerow([name, r["precision"], r["recall"], r["f1-score"], int(r["support"])])
    size = max(6, len(names) * 0.32)
    fig, ax = plt.subplots(figsize=(size + 2, size))
    try:
        im = ax.imshow(matrix, cmap="Blues", interpolation="nearest")
        ax.set(xticks=range(len(names)), yticks=range(len(names)), xticklabels=names,
               yticklabels=names, xlabel="Predicted class", ylabel="True class", title=head)
        plt.setp(ax.get_xticklabels(), rotation=90, fontsize=8)
        plt.setp(ax.get_yticklabels(), fontsize=8)
        fig.colorbar(im, ax=ax, label="Examples")
        fig.tight_layout()
        fig.savefig(out / f"confusion_{head}.png", dpi=160, bbox_inches="tight")
    finally:
        plt.close(fig)


def fingerprint(rows):
    h = hashlib.sha256()
    for row in rows:
        img = row["image"].convert("RGB")
        meta = json.dumps({"labels": {k:v for k,v in row.items() if k != "image"},
                           "size": img.size}, sort_keys=True).encode()
        for value in (meta, img.tobytes()):
            h.update(len(value).to_bytes(8, "big")); h.update(value)
    return h.hexdigest()


def checkpoint_hashes(model_dir):
    return {name: hashlib.sha256((model_dir/name).read_bytes()).hexdigest()
            for name in ("heads.pt", "label_maps.json", "config.json")}


def git_revision():
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=Path(__file__).parent,
                                       text=True, stderr=subprocess.DEVNULL).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def main(argv=None):
    args = arguments(argv)
    print(DISCLAIMER, file=sys.stderr)
    hashes = checkpoint_hashes(args.model)
    rows, source = select_rows(args)
    if not rows:
        raise ValueError("no evaluation rows")
    from clip_heads import ClipAttr
    model = ClipAttr(device=args.device)
    model.load_heads(str(args.model))
    model.heads.eval()
    maps = model.label_maps
    expected = {"category", "subcategory", "formality"} if args.headset == "fashion" else {"pattern", "fabric", "sleeveLength", "neckline"}
    if set(maps) != expected or any(not v or len(set(v)) != len(v) for v in maps.values()):
        raise ValueError("checkpoint attribute vocabulary does not match selected headset")
    gold, policies = encode_labels(rows, maps, args.headset)
    predictions = {h: [] for h in maps}
    with torch.inference_mode():
        for start in range(0, len(rows), args.batch_size):
            logits = model.heads(model.features([r["image"] for r in rows[start:start+args.batch_size]]))
            for head in maps:
                predictions[head].extend(logits[head].argmax(-1).cpu().tolist())
    args.out.mkdir(parents=True, exist_ok=True)
    metrics = {}
    print(f"{'attribute':<14} {'acc':>6} {'macro-F1':>9} {'n':>6} {'classes':>8}")
    for head, names in maps.items():
        m, report, matrix, policy = score_head(gold[head], predictions[head], names, args.headset == "dfmm")
        metrics[head] = m
        policies[head].update(policy)
        save_head(args.out, head, names, report, matrix)
        acc = f"{m['accuracy']:.1%}" if m["accuracy"] is not None else "n/a"
        f1 = f"{m['macro_f1']:.3f}" if m["macro_f1"] is not None else "n/a"
        print(f"{head:<14} {acc:>6} {f1:>9} {m['n']:>6} {m['n_classes']:>8}")
    versions = {}
    for package in ["torch", "transformers", "datasets", "huggingface-hub", "numpy", "scikit-learn", "matplotlib", "pillow"]:
        versions[package] = importlib.metadata.version(package)
    provenance = {"interpretation": DISCLAIMER, "historical_split_verified": False,
                  "training_overlap": "unknown", "git_commit": git_revision(),
                  "checkpoint_sha256": hashes, "source": source,
                  "selected_rows_sha256": fingerprint(rows), "label_policy": policies,
                  "arguments": {k: str(v) if isinstance(v, Path) else v for k,v in vars(args).items()},
                  "device": args.device, "python": sys.version, "packages": versions}
    for name, value in [("metrics.json", metrics), ("provenance.json", provenance)]:
        (args.out/name).write_text(json.dumps(value, indent=2, allow_nan=False)+"\n", encoding="utf-8")
    if checkpoint_hashes(args.model) != hashes:
        raise RuntimeError("checkpoint changed during evaluation")


if __name__ == "__main__":
    main()
