#!/usr/bin/env bash
#
# Smart Mirror kiosk launcher — runs inside the labwc Wayland session.
# Waits for the mirror UI to be reachable, then opens Chromium in kiosk mode.
# Managed by lwrespawn in ~/.config/labwc/autostart so it restarts on crash.
#
set -euo pipefail

export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# Ensure all outputs are powered on (wlr-output-power-management).
/usr/bin/wlopm --on '*' 2>/dev/null || true

# Poll until the mirror UI (:3001) is ready — up to 90 s.
echo "[kiosk] Waiting for UI on :3001..."
for i in $(seq 1 90); do
  if curl -sf http://localhost:3001 >/dev/null 2>&1; then
    echo "[kiosk] UI ready after ${i}s — launching Chromium."
    break
  fi
  sleep 1
done

exec /usr/bin/chromium \
  --kiosk \
  --app=http://localhost:3001 \
  --ozone-platform=wayland \
  --user-data-dir="$HOME/.config/chromium-kiosk" \
  --password-store=basic \
  --noerrdialogs \
  --disable-infobars \
  --disable-session-crashed-bubble \
  --disable-features=TranslateUI \
  --check-for-update-interval=31536000
