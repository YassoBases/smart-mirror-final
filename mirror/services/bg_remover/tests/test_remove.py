"""Round-trips a fixture through /remove and asserts the cutout has real alpha.

The bg-removal model (rembg/u2net) is downloaded on first use; if it isn't
available (offline test env), the removal assertions are skipped — but /health
and the input-validation path are always checked.
"""
import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app import app

client = TestClient(app)


def _fixture_png() -> bytes:
    # White canvas with a solid dark circle subject — rembg should keep the
    # circle and make the corners transparent.
    img = Image.new("RGB", (320, 320), (255, 255, 255))
    d = ImageDraw.Draw(img)
    d.ellipse((80, 80, 240, 240), fill=(20, 30, 40))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_remove_rejects_non_image():
    r = client.post("/remove", files={"image": ("x.txt", b"not an image", "text/plain")})
    assert r.status_code == 400


def test_remove_roundtrip_alpha():
    r = client.post("/remove", files={"image": ("subject.png", _fixture_png(), "image/png")})
    if r.status_code == 503:
        pytest.skip("rembg model unavailable in this environment")
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"

    out = Image.open(io.BytesIO(r.content))
    assert out.mode == "RGBA", "output must carry an alpha channel"
    alpha = out.getchannel("A")
    lo, hi = alpha.getextrema()
    # Removal occurred if at least some pixels are (near-)transparent — corners
    # of the white background should be cut away.
    assert lo == 0, "expected fully-transparent background pixels"
    assert hi > 0, "expected the subject to remain opaque"
