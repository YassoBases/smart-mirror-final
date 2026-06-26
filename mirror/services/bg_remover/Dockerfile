FROM python:3.11-slim

# rembg/onnxruntime + pillow need a few native libs at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the u2net model into the image so the first request isn't slow.
RUN python -c "from rembg import new_session; new_session('u2net')"

COPY . .

EXPOSE 8001
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8001"]
