"""OPTIONAL gesture-recapture tool for a *learned* wardrobe_invoke gesture.

The shipped mirror recognizes wardrobe_invoke geometrically (open-palm dwell) and
does NOT need this tool — see docs/wardrobe/wardrobe_gestures.md. Use this only if
you want to replace the geometric dwell with a small trained classifier.

There is no pre-existing gesture MLP to fine-tune, so "freeze the feature
extractor, retrain the head" maps to: MediaPipe Hands is the fixed feature
extractor (it outputs 21 landmarks); we train only a small head on those
landmarks. This is a documented HUMAN task — it is not run during the build.

Flow:
  1. RECORD  — capture 50–100 samples per household member for the new gesture
               and for a "negative/other" class, from the webcam.
  2. TRAIN   — fit a small MLP head on the flattened, wrist-normalized 21×3
               landmarks; report held-out accuracy.
  3. EXPORT  — write models/wardrobe_gesture.json (weights + label map) for a
               JS/TF.js head to consume in the mirror.

Usage:
  python tools/gesture_recapture.py record --label wardrobe_invoke --member alex --count 80
  python tools/gesture_recapture.py record --label other          --member alex --count 80
  python tools/gesture_recapture.py train  --out tools/models/wardrobe_gesture.json

Requires: mediapipe, opencv-python, numpy, scikit-learn (install only if you opt in).
"""
from __future__ import annotations

import argparse
import glob
import json
import os

DATA_DIR = os.path.join(os.path.dirname(__file__), "gesture_samples")
MODELS_DIR = os.path.join(os.path.dirname(__file__), "models")


def _normalize(landmarks):
    """Wrist-relative, scale-normalized 21×3 landmarks → flat list of 63 floats."""
    import numpy as np

    pts = np.array(landmarks, dtype=float).reshape(21, 3)
    pts -= pts[0]  # translate so the wrist is the origin
    scale = np.linalg.norm(pts, axis=1).max() or 1.0
    return (pts / scale).reshape(-1).tolist()


def record(args) -> None:
    import cv2
    import mediapipe as mp

    os.makedirs(DATA_DIR, exist_ok=True)
    out_path = os.path.join(DATA_DIR, f"{args.label}__{args.member}.jsonl")
    hands = mp.solutions.hands.Hands(max_num_hands=1, min_detection_confidence=0.6)
    cap = cv2.VideoCapture(0)
    saved = 0
    print(f"Recording '{args.label}' for {args.member}. Hold the pose; press q to stop.")
    while saved < args.count:
        ok, frame = cap.read()
        if not ok:
            break
        res = hands.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        if res.multi_hand_landmarks:
            lm = res.multi_hand_landmarks[0].landmark
            row = _normalize([[p.x, p.y, p.z] for p in lm])
            with open(out_path, "a", encoding="utf-8") as f:
                f.write(json.dumps({"label": args.label, "x": row}) + "\n")
            saved += 1
        cv2.putText(frame, f"{args.label}: {saved}/{args.count}", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
        cv2.imshow("gesture_recapture", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break
    cap.release()
    cv2.destroyAllWindows()
    print(f"Saved {saved} samples -> {out_path}")


def train(args) -> None:
    import numpy as np
    from sklearn.model_selection import train_test_split
    from sklearn.neural_network import MLPClassifier

    rows = []
    for path in glob.glob(os.path.join(DATA_DIR, "*.jsonl")):
        for line in open(path, encoding="utf-8"):
            rows.append(json.loads(line))
    if len(rows) < 20:
        raise SystemExit("Not enough samples — record more first.")

    labels = sorted({r["label"] for r in rows})
    label_to_idx = {l: i for i, l in enumerate(labels)}
    X = np.array([r["x"] for r in rows])
    y = np.array([label_to_idx[r["label"]] for r in rows])

    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.2, random_state=42, stratify=y)
    clf = MLPClassifier(hidden_layer_sizes=(32,), max_iter=500, random_state=42)
    clf.fit(Xtr, ytr)
    print(f"held-out accuracy: {clf.score(Xte, yte):.3f}  (labels: {labels})")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    export = {
        "labels": labels,
        "input_dim": X.shape[1],
        "coefs": [c.tolist() for c in clf.coefs_],
        "intercepts": [b.tolist() for b in clf.intercepts_],
        "activation": clf.activation,
        "out_activation": clf.out_activation_,
    }
    json.dump(export, open(args.out, "w", encoding="utf-8"))
    print(f"exported -> {args.out}")
    print("Wire-up is a follow-up: load this head in the mirror and feed it the "
          "same wrist-normalized landmarks MediaPipe already produces.")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("record", help="capture samples from the webcam")
    r.add_argument("--label", required=True, help="e.g. wardrobe_invoke or other")
    r.add_argument("--member", required=True, help="household member id/name")
    r.add_argument("--count", type=int, default=80)
    r.set_defaults(func=record)

    t = sub.add_parser("train", help="train the small head and export JSON")
    t.add_argument("--out", default=os.path.join(MODELS_DIR, "wardrobe_gesture.json"))
    t.set_defaults(func=train)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
