"""Convert a fashion captioning dataset into BLIP-2 LoRA JSONL.

Default source: **DeepFashion-MultiModal** (rich per-image shape + fabric +
pattern annotations). Alternatives the team can swap in:
  * Fashion200K — product titles give strong *subcategory* supervision.
  * FashionGen — paired image/description with category + composition.

Each output line is one training example:
    {"image": "<abs path>", "prompt": "<instruction>", "target": "<json>"}
where target is the JSON of the six fields in attributes.TARGET_FIELDS
(subcategory, fabric, formality, neckline, sleeveLength, pattern).

Usage:
    python dataset_prep.py --source /data/DeepFashion-MultiModal --out ./data
    # produces data/train.jsonl, data/val.jsonl, data/test.jsonl (80/10/10)

Download DeepFashion-MultiModal and its label files first; this script only reads
the official annotation txts. Label encodings below follow the dataset's README —
verify them against your downloaded copy and adjust the maps if they differ.
"""
from __future__ import annotations

import argparse
import json
import os
import random
from typing import Dict, List, Optional

import attributes as attr

PROMPT = "Describe this garment as JSON with keys subcategory, fabric, formality, neckline, sleeveLength, pattern."

# ── DeepFashion-MultiModal label encodings (per the dataset README) ───────────
SLEEVE = {0: "sleeveless", 1: "short-sleeve", 2: "medium-sleeve", 3: "long-sleeve", 4: "not-long-sleeve", 5: None}
NECKLINE = {0: "v-neck", 1: "square", 2: "round", 3: "standing", 4: "lapel", 5: "suspenders", 6: None}
FABRIC = {0: "denim", 1: "cotton", 2: "leather", 3: "furry", 4: "knitted", 5: "chiffon", 6: "other", 7: None}
PATTERN = {0: "print", 1: "print", 2: "stripe", 3: "solid", 4: "plaid", 5: "other", 6: "other", 7: None}

# Index of each attribute within shape_anno_all.txt (0-based, after the filename).
SHAPE_SLEEVE_IDX = 0
SHAPE_NECKLINE_IDX = 9


def _read_space_table(path: str) -> Dict[str, List[str]]:
    """Reads 'filename v1 v2 ...' lines into {filename: [v1, v2, ...]}."""
    out: Dict[str, List[str]] = {}
    if not os.path.exists(path):
        return out
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 2:
                out[parts[0]] = parts[1:]
    return out


def _formality_cue(fabric: Optional[str], neckline: Optional[str], pattern: Optional[str]) -> int:
    """Coarse 1-5 formality from visual cues — a weak label the team can refine."""
    score = 3
    if fabric in ("leather", "knitted"):
        score += 1
    if fabric in ("denim",):
        score -= 1
    if neckline in ("lapel", "standing"):
        score += 1
    if pattern in ("solid",):
        score += 0
    if pattern in ("print", "plaid"):
        score -= 1
    return max(1, min(5, score))


def build_examples(source: str) -> List[Dict]:
    img_dir = os.path.join(source, "images")
    shape = _read_space_table(os.path.join(source, "labels", "shape", "shape_anno_all.txt"))
    fabric_t = _read_space_table(os.path.join(source, "labels", "texture", "fabric_ann.txt"))
    pattern_t = _read_space_table(os.path.join(source, "labels", "texture", "pattern_ann.txt"))

    if not shape:
        raise SystemExit(
            f"No shape annotations under {source}/labels/shape/. Download "
            "DeepFashion-MultiModal first (see README), or pass --source to its root."
        )

    examples: List[Dict] = []
    for fname, vals in shape.items():
        def at(idx, table):
            try:
                return int(table.get(fname, [])[idx])
            except (IndexError, ValueError):
                return None

        def lookup(m, k):
            return m.get(k) if isinstance(k, int) else None

        sleeve = SLEEVE.get(int(vals[SHAPE_SLEEVE_IDX])) if len(vals) > SHAPE_SLEEVE_IDX else None
        neckline = NECKLINE.get(int(vals[SHAPE_NECKLINE_IDX])) if len(vals) > SHAPE_NECKLINE_IDX else None
        fabric = lookup(FABRIC, at(0, fabric_t)) if fabric_t else None  # 'upper' fabric column
        pattern = lookup(PATTERN, at(0, pattern_t)) if pattern_t else None  # 'upper' pattern column

        target = {
            "subcategory": None,  # DFMM has no clean subcategory label; Fashion200K titles fill this
            "fabric": fabric,
            "formality": _formality_cue(fabric, neckline, pattern),
            "neckline": neckline,
            "sleeveLength": sleeve,
            "pattern": pattern if pattern in attr.VALID_PATTERNS else (pattern or "solid"),
        }
        image_path = os.path.join(img_dir, fname)
        examples.append({"image": image_path, "prompt": PROMPT, "target": attr.format_target(target)})
    return examples


def split_and_write(examples: List[Dict], out_dir: str, seed: int = 42) -> None:
    os.makedirs(out_dir, exist_ok=True)
    random.Random(seed).shuffle(examples)
    n = len(examples)
    n_train, n_val = int(n * 0.8), int(n * 0.1)
    splits = {
        "train": examples[:n_train],
        "val": examples[n_train : n_train + n_val],
        "test": examples[n_train + n_val :],
    }
    for name, rows in splits.items():
        path = os.path.join(out_dir, f"{name}.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        print(f"wrote {len(rows):>6} -> {path}")


def main() -> None:
    p = argparse.ArgumentParser(description="Prepare BLIP-2 LoRA JSONL from a fashion dataset")
    p.add_argument("--source", required=True, help="Dataset root (default layout: DeepFashion-MultiModal)")
    p.add_argument("--out", default="./data", help="Output dir for {train,val,test}.jsonl")
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    examples = build_examples(args.source)
    print(f"built {len(examples)} examples from {args.source}")
    split_and_write(examples, args.out, args.seed)


if __name__ == "__main__":
    main()
