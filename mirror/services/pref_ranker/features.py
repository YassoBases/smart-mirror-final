"""Outfit feature engineering for the per-profile preference ranker.

An outfit (a list of item-attribute dicts, same shape as the API item) is turned
into:

  * an "outfit vector" — normalized concat of one-hot category + one-hot top-50
    subcategory + primary RGB + formality + warmth — used for centroid/cosine, and
  * a 6-dim feature row fed to the LGBMRanker:
      cosine similarity to the centroid of liked outfits,
      item co-occurrence frequency in liked outfits,
      formality match vs context,
      warmth match vs temperature,
      season-match boolean,
      novelty (1 / (1 + days_since_last_worn)).
"""
from __future__ import annotations

from datetime import datetime
from itertools import combinations
from typing import Any, Dict, List

import numpy as np

CATEGORIES = ["top", "bottom", "outerwear", "footwear", "accessory"]
MAX_SUBCATS = 50
NEVER_WORN_DAYS = 365.0


def _hex_to_rgb(value: Any) -> List[float]:
    if isinstance(value, str) and value.startswith("#") and len(value) == 7:
        try:
            return [int(value[i : i + 2], 16) / 255.0 for i in (1, 3, 5)]
        except ValueError:
            pass
    return [0.5, 0.5, 0.5]


def _days_since(last_worn_at: Any) -> float:
    if not last_worn_at:
        return NEVER_WORN_DAYS
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(str(last_worn_at)[: len(fmt) + 2], fmt)
            return max(0.0, (datetime.now() - dt).total_seconds() / 86400.0)
        except ValueError:
            continue
    return NEVER_WORN_DAYS


def build_subcat_vocab(samples: List[Dict[str, Any]]) -> List[str]:
    """Top-N subcategories by frequency across all sample outfits."""
    counts: Dict[str, int] = {}
    for s in samples:
        for item in s.get("items", []):
            sub = item.get("subcategory")
            if sub:
                counts[sub] = counts.get(sub, 0) + 1
    ordered = sorted(counts, key=lambda k: (-counts[k], k))
    return ordered[:MAX_SUBCATS]


def outfit_vector(items: List[Dict[str, Any]], subcat_vocab: List[str]) -> np.ndarray:
    cat = np.zeros(len(CATEGORIES))
    sub = np.zeros(len(subcat_vocab))
    rgb = np.zeros(3)
    formality = []
    warmth = []
    for item in items:
        c = item.get("category")
        if c in CATEGORIES:
            cat[CATEGORIES.index(c)] = 1.0
        s = item.get("subcategory")
        if s in subcat_vocab:
            sub[subcat_vocab.index(s)] = 1.0
        rgb += np.array(_hex_to_rgb(item.get("primaryColor")))
        if isinstance(item.get("formality"), (int, float)):
            formality.append(float(item["formality"]))
        if isinstance(item.get("warmth"), (int, float)):
            warmth.append(float(item["warmth"]))
    n = max(len(items), 1)
    rgb /= n
    f = (np.mean(formality) if formality else 3.0) / 5.0
    w = (np.mean(warmth) if warmth else 3.0) / 5.0
    vec = np.concatenate([cat, sub, rgb, [f, w]])
    norm = np.linalg.norm(vec)
    return vec / norm if norm > 0 else vec


# A chosen occasion is a much stronger formality signal than time of day.
OCCASION_FORMALITY = {
    "sport": 1.5,
    "casual": 2.0,
    "smart casual": 3.0,
    "party": 3.5,
    "business": 4.0,
    "formal": 5.0,
}


def _target_formality(context: Dict[str, Any]) -> float:
    occ = (context or {}).get("occasion")
    if isinstance(occ, str) and occ.lower() in OCCASION_FORMALITY:
        return OCCASION_FORMALITY[occ.lower()]
    tod = (context or {}).get("timeOfDay")
    return {"morning": 2.5, "afternoon": 2.5, "evening": 3.5, "night": 3.5}.get(tod, 3.0)


def _target_warmth(context: Dict[str, Any]) -> float:
    temp = (context or {}).get("temperature")
    if not isinstance(temp, (int, float)):
        return 3.0
    if temp < 5:
        return 5.0
    if temp < 12:
        return 4.0
    if temp < 18:
        return 3.0
    if temp < 24:
        return 2.0
    return 1.0


def _avg(items, key, default):
    vals = [float(i[key]) for i in items if isinstance(i.get(key), (int, float))]
    return sum(vals) / len(vals) if vals else default


def candidate_features(
    items: List[Dict[str, Any]],
    context: Dict[str, Any],
    stats: Dict[str, Any],
) -> List[float]:
    subcat_vocab = stats.get("subcat_vocab", [])
    centroid = stats.get("centroid")
    cooccur = stats.get("cooccur", {})
    cooccur_max = stats.get("cooccur_max", 1) or 1

    vec = outfit_vector(items, subcat_vocab)
    if centroid is not None and np.linalg.norm(centroid) > 0:
        cos = float(np.dot(vec, centroid) / (np.linalg.norm(vec) * np.linalg.norm(centroid) + 1e-9))
    else:
        cos = 0.0

    ids = sorted(i["id"] for i in items if "id" in i)
    pair_counts = [cooccur.get(f"{a}-{b}", 0) for a, b in combinations(ids, 2)]
    cooccur_freq = (sum(pair_counts) / len(pair_counts) / cooccur_max) if pair_counts else 0.0

    formality_match = 1.0 - abs(_avg(items, "formality", 3.0) - _target_formality(context)) / 4.0
    warmth_match = 1.0 - abs(_avg(items, "warmth", 3.0) - _target_warmth(context)) / 4.0

    season = (context or {}).get("season")
    season_match = 1.0 if any(season in (i.get("seasons") or []) for i in items) else 0.0

    days = [_days_since(i.get("lastWornAt")) for i in items]
    novelty = float(np.mean([1.0 / (1.0 + d) for d in days])) if days else 0.0

    return [cos, cooccur_freq, formality_match, warmth_match, season_match, novelty]


def build_stats(samples: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Derives centroid + co-occurrence + subcategory vocab from liked outfits."""
    subcat_vocab = build_subcat_vocab(samples)
    liked = [s for s in samples if int(s.get("label", 0)) == 1]

    vectors = [outfit_vector(s.get("items", []), subcat_vocab) for s in liked]
    centroid = np.mean(vectors, axis=0) if vectors else None

    cooccur: Dict[str, int] = {}
    for s in liked:
        ids = sorted(i["id"] for i in s.get("items", []) if "id" in i)
        for a, b in combinations(ids, 2):
            key = f"{a}-{b}"
            cooccur[key] = cooccur.get(key, 0) + 1
    cooccur_max = max(cooccur.values()) if cooccur else 1

    return {
        "subcat_vocab": subcat_vocab,
        "centroid": centroid,
        "cooccur": cooccur,
        "cooccur_max": cooccur_max,
    }


def heuristic_score(items: List[Dict[str, Any]], context: Dict[str, Any]) -> float:
    """Used before a profile has a trained model: reward season/formality/warmth fit."""
    f = candidate_features(items, context, {"subcat_vocab": []})
    # cos + cooccur are 0 without stats; weight the context-fit features.
    return 0.4 * f[2] + 0.4 * f[3] + 0.2 * f[4]
