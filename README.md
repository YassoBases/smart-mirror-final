# Smart Mirror Final

A combined repository for the Smart Mirror project, containing both halves:

- **`mirror/`** — the smart mirror itself: a React display (the mirror UI), a
  Node/Express backend (REST API + WebSocket sync), and Python AI sidecars
  (`bg_remover`, `pref_ranker`, BLIP/CLIP captioner) under `mirror/services/`.
- **`app/`** — the Flutter companion phone app (`smart_mirror_app`) for managing
  profiles, the wardrobe/closet, outfit suggestions, and household settings.

The two communicate over the backend's REST API; settings (API keys, AI config)
and profiles sync across the phone and the mirror via the backend as the single
source of truth.

## Layout

```
smart-mirror-final/
├── mirror/            # React UI + backend + services (was Smart-Mirror-Combined)
│   ├── src/           #   mirror display (CRA)
│   ├── backend/       #   Node/Express API
│   ├── services/      #   Python AI sidecars (bg_remover, pref_ranker, captioner)
│   └── sync/          #   pairing + state sync
└── app/               # Flutter phone app (was Smart_Mirror_Program)
    ├── lib/
    └── ...
```

## Running

### Backend (mirror/backend)
```bash
cd mirror/backend
npm install
cp .env.example .env          # set OPENAI_API_KEY / REPLICATE_API_TOKEN etc. (or via Settings)
node server.js                # http://localhost:3000
```

### Mirror display (mirror)
```bash
cd mirror
npm install
PORT=3001 npm start           # http://localhost:3001  (backend must be on :3000)
```

### AI sidecars (mirror/services/*)
Each has a `requirements.txt`; create a venv, `pip install -r requirements.txt`,
then `uvicorn app:app --port <8001 bg_remover | 8002 pref_ranker | 8003 captioner>`.
All are optional — the backend degrades gracefully when one is down.

### App (app)
```bash
cd app
flutter pub get
flutter run                   # or: flutter build apk --debug
```
Point the app at the backend (scan the mirror QR or enter the URL in settings).

## Notes
- Dependencies, virtualenvs, build output, runtime `data/`, and `.env` files are
  git-ignored. Trained CLIP attribute heads under
  `mirror/services/blip2_captioner/clip_attr_*` are committed (small) so the
  captioner works out of the box.
- The outfit stylist and the voice assistant share one household OpenAI key,
  configurable from either the app or the mirror Settings page.
