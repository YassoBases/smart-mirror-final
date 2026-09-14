import importlib
import io
import os
import tempfile
import unittest
from unittest.mock import patch

import torch
from fastapi.testclient import TestClient
from PIL import Image

from identity_head import IdentityHead


def jpeg_bytes():
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), (10, 20, 30)).save(buf, "JPEG")
    return buf.getvalue()


class FakeModel:
    """Stands in for ClipAttr so tests never load real CLIP weights."""

    def features(self, images):
        return torch.full((len(images), 512), 0.1)


class IdentityEmbedTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("WARDROBE_IDENTITY_MODEL_DIR", None)
        os.environ.pop("WARDROBE_ATTR_ENDPOINT_TOKEN", None)

    def test_embed_falls_back_to_raw_clip_without_a_trained_head(self):
        with patch.dict(os.environ, {}, clear=False):
            import serve_clip
            importlib.reload(serve_clip)
            with patch.object(serve_clip, "_load", return_value=(FakeModel(), [])):
                client = TestClient(serve_clip.app)
                res = client.post("/embed", files={"image": ("g.jpg", jpeg_bytes(), "image/jpeg")})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["projected"], False)
        self.assertEqual(body["dim"], 512)
        self.assertEqual(len(body["embedding"]), 512)

    def test_embed_applies_a_trained_identity_head_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            IdentityHead(in_dim=512, hidden=16, out_dim=32).save(tmp)
            with patch.dict(os.environ, {"WARDROBE_IDENTITY_MODEL_DIR": tmp}, clear=False):
                import serve_clip
                importlib.reload(serve_clip)
                with patch.object(serve_clip, "_load", return_value=(FakeModel(), [])):
                    client = TestClient(serve_clip.app)
                    res = client.post("/embed", files={"image": ("g.jpg", jpeg_bytes(), "image/jpeg")})
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["projected"], True)
        self.assertEqual(body["dim"], 32)
        self.assertEqual(len(body["embedding"]), 32)
        # The head's output is L2-normalized.
        norm = sum(v * v for v in body["embedding"]) ** 0.5
        self.assertAlmostEqual(norm, 1.0, places=4)

    def test_health_reports_identity_head_presence(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"WARDROBE_IDENTITY_MODEL_DIR": os.path.join(tmp, "missing")}, clear=False):
                import serve_clip
                importlib.reload(serve_clip)
                client = TestClient(serve_clip.app)
                self.assertEqual(client.get("/health").json()["identity_head_trained"], False)

            IdentityHead(in_dim=512, hidden=16, out_dim=32).save(os.path.join(tmp, "present"))
            with patch.dict(os.environ, {"WARDROBE_IDENTITY_MODEL_DIR": os.path.join(tmp, "present")}, clear=False):
                importlib.reload(serve_clip)
                client = TestClient(serve_clip.app)
                self.assertEqual(client.get("/health").json()["identity_head_trained"], True)

    def test_embed_rejects_an_invalid_image(self):
        import serve_clip
        importlib.reload(serve_clip)
        with patch.object(serve_clip, "_load", return_value=(FakeModel(), [])):
            client = TestClient(serve_clip.app)
            res = client.post("/embed", files={"image": ("g.jpg", b"not an image", "image/jpeg")})
        self.assertEqual(res.status_code, 400)

    def test_embed_enforces_the_bearer_token_when_configured(self):
        with patch.dict(os.environ, {"WARDROBE_ATTR_ENDPOINT_TOKEN": "secret"}, clear=False):
            import serve_clip
            importlib.reload(serve_clip)
            with patch.object(serve_clip, "_load", return_value=(FakeModel(), [])):
                client = TestClient(serve_clip.app)
                unauthorized = client.post("/embed", files={"image": ("g.jpg", jpeg_bytes(), "image/jpeg")})
                authorized = client.post(
                    "/embed", files={"image": ("g.jpg", jpeg_bytes(), "image/jpeg")},
                    headers={"Authorization": "Bearer secret"},
                )
        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(authorized.status_code, 200)


if __name__ == "__main__":
    unittest.main()
