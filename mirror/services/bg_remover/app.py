"""bg_remover sidecar — strips the background from a garment photo.

POST /remove  (multipart field "image")  -> transparent PNG (rembg / u2net)
GET  /health
"""
import io

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response
from PIL import Image

app = FastAPI(title="bg_remover")

# rembg + the u2net session are loaded lazily so the process (and /health) come
# up fast and tests can import the app without the model present.
_session = None


def _get_session():
    global _session
    if _session is None:
        from rembg import new_session

        _session = new_session("u2net")
    return _session


@app.get("/health")
def health():
    return {"status": "ok", "model": "u2net"}


@app.post("/remove")
async def remove_background(image: UploadFile = File(...)):
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty upload")

    # Validate it's a decodable image before handing bytes to rembg.
    try:
        Image.open(io.BytesIO(data)).verify()
    except Exception:
        raise HTTPException(status_code=400, detail="invalid image")

    try:
        from rembg import remove

        out = remove(data, session=_get_session())  # PNG bytes with alpha
    except Exception as exc:  # model download / inference failure
        return JSONResponse(status_code=503, content={"error": str(exc)})

    return Response(content=out, media_type="image/png")
