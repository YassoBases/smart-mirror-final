"""Covers /score shape (heuristic + trained) and the train→score round-trip."""
import os
import tempfile

# Isolate model storage before importing the app.
os.environ["MODELS_DIR"] = tempfile.mkdtemp(prefix="prefmodels-")

from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402

client = TestClient(app)


def _item(item_id, category, subcategory, formality, warmth, seasons, color="#334455"):
    return {
        "id": item_id,
        "category": category,
        "subcategory": subcategory,
        "primaryColor": color,
        "secondaryColors": [],
        "pattern": "solid",
        "formality": formality,
        "warmth": warmth,
        "seasons": seasons,
        "tags": [],
        "lastWornAt": None,
    }


def _context():
    return {"temperature": 8, "weather": "Clouds", "timeOfDay": "evening", "season": "winter"}


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_score_heuristic_shape_without_model():
    r = client.post(
        "/score",
        json={
            "profile_id": 1,
            "context": _context(),
            "candidates": [
                {"item_ids": [1, 2], "items": [
                    _item(1, "top", "sweater", 3, 4, ["winter"]),
                    _item(2, "bottom", "jeans", 2, 3, ["winter"]),
                ]},
                {"item_ids": [3, 4], "items": [
                    _item(3, "top", "tank", 1, 1, ["summer"]),
                    _item(4, "bottom", "shorts", 1, 1, ["summer"]),
                ]},
            ],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["model"] is False
    assert len(body["scores"]) == 2
    assert all(isinstance(s, float) for s in body["scores"])
    # The winter outfit fits the winter/evening/cold context better.
    assert body["scores"][0] > body["scores"][1]


def test_train_then_score_roundtrip():
    pid = 42
    winter_like = [
        _item(1, "top", "sweater", 3, 4, ["winter"]),
        _item(2, "bottom", "jeans", 2, 4, ["winter"]),
    ]
    summer_dislike = [
        _item(3, "top", "tank", 1, 1, ["summer"]),
        _item(4, "bottom", "shorts", 1, 1, ["summer"]),
    ]
    samples = []
    for _ in range(4):
        samples.append({"items": winter_like, "context": _context(), "label": 1})
        samples.append({"items": summer_dislike, "context": _context(), "label": 0})

    tr = client.post("/train", json={"profile_id": pid, "samples": samples})
    assert tr.status_code == 200, tr.text
    body = tr.json()
    assert body["trained"] is True
    assert body["n"] == len(samples)
    assert os.path.exists(body["model_path"])

    sc = client.post(
        "/score",
        json={
            "profile_id": pid,
            "context": _context(),
            "candidates": [
                {"item_ids": [1, 2], "items": winter_like},
                {"item_ids": [3, 4], "items": summer_dislike},
            ],
        },
    )
    assert sc.status_code == 200
    body = sc.json()
    assert body["model"] is True
    assert len(body["scores"]) == 2
    # Classifier scores are P(like) probabilities in [0, 1].
    assert all(0.0 <= s <= 1.0 for s in body["scores"])
    # The model learned the preference: the liked winter outfit outscores the
    # disliked summer one.
    assert body["scores"][0] > body["scores"][1]

    # /health reports the trained model.
    h = client.get("/health").json()
    assert str(pid) in h["models"]


def test_train_insufficient_labels():
    r = client.post(
        "/train",
        json={"profile_id": 7, "samples": [{"items": [], "context": {}, "label": 1}]},
    )
    assert r.status_code == 200
    assert r.json()["trained"] is False
