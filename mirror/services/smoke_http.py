"""Start real CPU services and exercise their HTTP contracts; never substitute mocks.

Run with the environment containing each service's requirements:
  python services/smoke_http.py --output docs/testing/evidence/services
HF_HOME and U2NET_HOME may point to predownloaded model caches.
"""
import argparse
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent

def request(url, body=None, content_type='application/json'):
    data = json.dumps(body).encode() if isinstance(body, dict) else body
    req = urllib.request.Request(url, data=data, headers={'Content-Type': content_type})
    with urllib.request.urlopen(req, timeout=180) as response:
        return response.read(), response.headers.get('Content-Type')

def upload(url, image):
    boundary = 'smart-mirror-smoke-boundary'
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="shirt.png"\r\nContent-Type: image/png\r\n\r\n'.encode()
            + image + f'\r\n--{boundary}--\r\n'.encode())
    return request(url, body, f'multipart/form-data; boundary={boundary}')

def fixture():
    image = Image.new('RGB', (256, 256), 'white')
    draw = ImageDraw.Draw(image)
    draw.polygon([(75, 40), (100, 30), (115, 50), (140, 50), (155, 30), (180, 40),
                  (230, 95), (195, 120), (180, 100), (180, 230), (75, 230), (75, 100), (55, 120), (25, 95)], fill='#234f89')
    buffer = io.BytesIO(); image.save(buffer, 'PNG'); return buffer.getvalue()

def smoke(name, url, image, output):
    if name == 'wardrobe_attr':
        data = json.loads(upload(url + '/', image)[0])
        expected = {'category', 'subcategory', 'primaryColor', 'secondaryColors', 'pattern', 'fabricGuess', 'formality', 'warmth', 'seasons', 'tags'}
        assert expected == set(data), data
        assert data['category'] in ['top', 'bottom', 'outerwear', 'footwear', 'accessory']
        assert 1 <= data['formality'] <= 5 and 1 <= data['warmth'] <= 5
        assert all(isinstance(data[k], list) for k in ['secondaryColors', 'seasons', 'tags'])
        (output / 'classifier-response.json').write_text(json.dumps(data, indent=2))
        return data
    if name == 'bg_remover':
        body, mime = upload(url + '/remove', image)
        assert mime == 'image/png', mime
        png = Image.open(io.BytesIO(body)); assert png.mode == 'RGBA', png.mode
        low, high = png.getchannel('A').getextrema()
        assert low < 255 and high > 128, (low, high)
        (output / 'removed.png').write_bytes(body)
        return {'alpha_min': low, 'alpha_max': high, 'size': png.size}
    context = {'temperature': 8, 'weather': 'Clouds', 'timeOfDay': 'evening', 'season': 'winter'}
    winter = {'category': 'top', 'subcategory': 'sweater', 'formality': 3, 'warmth': 5, 'seasons': ['winter']}
    summer = {'category': 'top', 'subcategory': 'tank', 'formality': 1, 'warmth': 1, 'seasons': ['summer']}
    candidates = [{'item_ids': [i + 1], 'items': [item]} for i, item in enumerate([winter, summer])]
    score = json.loads(request(url + '/score', {'profile_id': 987654, 'context': context, 'candidates': candidates})[0])
    assert score['model'] is False and score['scores'][0] > score['scores'][1], score
    samples = [{'items': [item], 'context': context, 'label': label} for _ in range(5) for item, label in [(winter, 1), (summer, 0)]]
    trained = json.loads(request(url + '/train', {'profile_id': 987654, 'samples': samples})[0])
    assert trained['trained'] is True, trained
    learned = json.loads(request(url + '/score', {'profile_id': 987654, 'context': context, 'candidates': candidates})[0])
    assert learned['model'] is True and learned['scores'][0] > learned['scores'][1], learned
    return {'heuristic': score, 'learned': learned}

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(); args.output.mkdir(parents=True, exist_ok=True)
    image = fixture(); (args.output / 'fixture.png').write_bytes(image)
    results = {}
    for name, module in [('wardrobe_attr', 'serve_clip'), ('bg_remover', 'app'), ('pref_ranker', 'app')]:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        with tempfile.TemporaryDirectory() as model_dir, (args.output / f'{name}.log').open('w') as log:
            process = subprocess.Popen([sys.executable, '-m', 'uvicorn', f'{module}:app', '--host', '127.0.0.1', '--port', str(port)], cwd=ROOT / name,
                env={**os.environ, 'MODELS_DIR': model_dir, 'OMP_NUM_THREADS': '2', 'MKL_NUM_THREADS': '2'}, stdout=log, stderr=log)
            started = time.monotonic(); url = f'http://127.0.0.1:{port}'
            try:
                while True:
                    if process.poll() is not None: raise RuntimeError(f'Service exited: see {name}.log')
                    try: request(url + '/health'); break
                    except OSError:
                        if time.monotonic() - started > 180: raise TimeoutError('Startup exceeded 180 seconds')
                        time.sleep(.25)
                result = smoke(name, url, image, args.output)
                results[name] = {'status': 'passed', 'result': result}
            except Exception as error:
                results[name] = {'status': 'failed', 'error': str(error)}
            finally:
                process.terminate()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
            results[name]['elapsed_seconds'] = round(time.monotonic() - started, 3)
            print(name, json.dumps(results[name]), flush=True)
    (args.output / 'results.json').write_text(json.dumps(results, indent=2))
    return int(any(result['status'] != 'passed' for result in results.values()))

if __name__ == '__main__':
    raise SystemExit(main())
