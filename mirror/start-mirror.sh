#!/usr/bin/env bash
# Starts all services needed for the smart mirror system:
#   1. Node.js backend  — HTTP :3000  (API for phone + mirror)  + WebSocket :4000 (mirror sync)
#   2. Sync bridge      — HTTP :4002  (QR/status for React UI)
#   3. React frontend   — HTTP :3001  (mirror display)
#   4. ngrok tunnel     — https://lifting-purplish-subsidize.ngrok-free.dev → :3000
#                         (optional; only for Gmail OAuth callback — all other traffic stays on LAN)
#
# Usage: ./start-mirror.sh
# Stop:  Ctrl-C (kills all child processes via the trap below)
#
# WiFi provisioning is handled by smartmirror-ble-setup.service (systemd),
# which runs independently of this script. The mirror display starts regardless
# of network state and shows SetupMode until the Pi comes online.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PI_IP=$(hostname -I | awk '{print $1}')

cleanup() {
  echo ""
  echo "[mirror] Shutting down..."
  kill "$BACKEND_PID" "$SYNC_PID" "$REACT_PID" "${NGROK_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Smart Mirror  |  Pi IP: $PI_IP"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 1. Backend ─────────────────────────────────────────────────────────────
echo "[1/4] Starting backend (HTTP :3000, WS :4000)..."
npm run backend:start > /tmp/mirror-backend.log 2>&1 &
BACKEND_PID=$!

# Wait until backend is accepting connections
for i in $(seq 1 20); do
  if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
    echo "      Backend ready."
    break
  fi
  sleep 1
done

# ── 2. ngrok tunnel (Gmail OAuth callback only) ────────────────────────────
NGROK_PID=""
if command -v ngrok >/dev/null 2>&1; then
  echo "[2/4] Starting ngrok tunnel → https://lifting-purplish-subsidize.ngrok-free.dev"
  ngrok http --url=https://lifting-purplish-subsidize.ngrok-free.dev 3000 \
    > /tmp/mirror-ngrok.log 2>&1 &
  NGROK_PID=$!
else
  echo "[!]  ngrok not found — Gmail OAuth callback will be unreachable (all other features OK)"
fi

# ── 3. Sync bridge ─────────────────────────────────────────────────────────
echo "[3/4] Starting sync bridge (:4002)…"
MIRROR_BACKEND_URL=ws://localhost:4000 npm run sync:mirror > /tmp/mirror-sync.log 2>&1 &
SYNC_PID=$!

sleep 4

# ── 4. React frontend ──────────────────────────────────────────────────────
echo "[4/4] Starting React mirror UI (:3001)…"
PORT=3001 BROWSER=none npm start > /tmp/mirror-react.log 2>&1 &
REACT_PID=$!

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Mirror UI   →  http://localhost:3001"
echo "  Backend     →  http://$PI_IP:3000"
echo "  OAuth tunnel→  https://lifting-purplish-subsidize.ngrok-free.dev (Gmail callback only)"
echo ""
echo "  Phone app — update kBaseUrl in app/lib/config/api.dart:"
echo "    const String kBaseUrl = 'http://$PI_IP:3000/api';"
echo ""
echo "  Logs:"
echo "    Backend : /tmp/mirror-backend.log"
echo "    Sync    : /tmp/mirror-sync.log"
echo "    React   : /tmp/mirror-react.log"
echo "    ngrok   : /tmp/mirror-ngrok.log"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

wait
