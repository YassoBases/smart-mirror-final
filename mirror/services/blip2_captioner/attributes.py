"""Shared attribute schema for the BLIP-2 captioner.

Keeps the fine-tune target and the serving output in lockstep so the deployed
endpoint emits exactly the item-attribute shape the backend's blip2_client expects
(see docs/wardrobe/01_api_contract.md §2). The model is trained to emit JSON for
the six visually-grounded fields below; serve.py augments that with pixel-derived
colors and rule-derived category/warmth/seasons.
"""
from __future__ import annotations

import json
from typing import Any, Dict

# The six fields BLIP-2 is fine-tuned to predict (visually grounded).
TARGET_FIELDS = ["subcategory", "fabric", "formality", "neckline", "sleeveLength", "pattern"]

VALID_CATEGORIES = ["top", "bottom", "outerwear", "footwear", "accessory"]
VALID_PATTERNS = ["solid", "stripe", "plaid", "print", "other"]
VALID_SEASONS = ["winter", "spring", "summer", "autumn"]

# Coarse subcategory → category map. Extend as the label set grows.
SUBCATEGORY_TO_CATEGORY = {
    # tops
    "t-shirt": "top", "shirt": "top", "blouse": "top", "henley": "top",
    "sweater": "top", "hoodie": "top", "tank": "top", "polo": "top",
    "dress": "top", "jumper": "top",
    # bottoms
    "jeans": "bottom", "trousers": "bottom", "chinos": "bottom",
    "shorts": "bottom", "skirt": "bottom", "leggings": "bottom",
    "joggers": "bottom", "sweatpants": "bottom",
    # outerwear
    "jacket": "outerwear", "coat": "outerwear", "blazer": "outerwear",
    "cardigan": "outerwear", "parka": "outerwear", "puffer": "outerwear",
    "trench": "outerwear", "overcoat": "outerwear", "windbreaker": "outerwear",
    # footwear
    "sneakers": "footwear", "boots": "footwear", "heels": "footwear",
    "loafers": "footwear", "sandals": "footwear", "trainers": "footwear",
    # accessory
    "hat": "accessory", "scarf": "accessory", "belt": "accessory", "bag": "accessory",
    "cap": "accessory", "gloves": "accessory", "sunglasses": "accessory",
    "watch": "accessory", "tie": "accessory", "beanie": "accessory",
}

# Substring → category fallback for labels not in the exact map above, so an
# unseen subcategory (e.g. "cargo pants", "chelsea boots") still lands in the
# right closet tab instead of silently defaulting to "top".
_CATEGORY_KEYWORDS = [
    ("bottom", ("pant", "jean", "trouser", "chino", "short", "skirt",
                "legging", "jogger", "sweatpant", "slack")),
    ("footwear", ("shoe", "sneaker", "boot", "heel", "loafer", "sandal",
                  "trainer", "flip", "footwear", "clog")),
    ("outerwear", ("jacket", "coat", "blazer", "cardigan", "parka", "puffer",
                   "trench", "overcoat", "windbreaker", "anorak")),
    ("accessory", ("hat", "cap", "scarf", "belt", "bag", "glove", "sunglass",
                   "watch", "tie", "beanie", "necklace", "earring", "ring")),
]

# Warmth (1-5) hint from fabric, before category adjustment.
FABRIC_WARMTH = {
    "denim": 3, "cotton": 2, "leather": 3, "furry": 5, "knitted": 4,
    "chiffon": 1, "wool": 5, "other": 3,
}


def format_target(attrs: Dict[str, Any]) -> str:
    """Serializes the six target fields to the JSON string used as the LoRA label."""
    return json.dumps({k: attrs.get(k) for k in TARGET_FIELDS}, ensure_ascii=False)


def parse_model_json(text: str) -> Dict[str, Any]:
    """Best-effort parse of the model's generated JSON (tolerates extra prose)."""
    try:
        start, end = text.index("{"), text.rindex("}") + 1
        return json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError):
        return {}


def category_for(subcategory: Any) -> str:
    if not isinstance(subcategory, str):
        return "top"
    s = subcategory.lower().strip()
    if s in SUBCATEGORY_TO_CATEGORY:
        return SUBCATEGORY_TO_CATEGORY[s]
    for category, keywords in _CATEGORY_KEYWORDS:
        if any(k in s for k in keywords):
            return category
    return "top"


def warmth_for(fabric: Any, category: str) -> int:
    base = FABRIC_WARMTH.get(str(fabric).lower(), 3) if fabric else 3
    if category == "outerwear":
        base = min(5, base + 1)
    return max(1, min(5, base))


def seasons_for(warmth: int) -> list:
    if warmth >= 4:
        return ["winter", "autumn"]
    if warmth <= 2:
        return ["spring", "summer"]
    return ["spring", "autumn"]


def to_full_item_attributes(model_json: Dict[str, Any], colors: Dict[str, Any]) -> Dict[str, Any]:
    """Combines the model's six fields + pixel colors into the API item shape."""
    sub = model_json.get("subcategory")
    category = category_for(sub)
    pattern = model_json.get("pattern")
    if pattern not in VALID_PATTERNS:
        pattern = "solid"
    formality = model_json.get("formality")
    formality = int(formality) if isinstance(formality, (int, float)) else 3
    formality = max(1, min(5, formality))
    fabric = model_json.get("fabric")
    warmth = warmth_for(fabric, category)

    tags = []
    if model_json.get("sleeveLength"):
        tags.append(str(model_json["sleeveLength"]))
    if model_json.get("neckline"):
        tags.append(str(model_json["neckline"]))

    return {
        "category": category,
        "subcategory": sub,
        "primaryColor": colors.get("primaryColor"),
        "secondaryColors": colors.get("secondaryColors", []),
        "pattern": pattern,
        "fabricGuess": fabric,
        "formality": formality,
        "warmth": warmth,
        "seasons": seasons_for(warmth),
        "tags": tags,
    }
