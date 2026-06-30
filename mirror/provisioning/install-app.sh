#!/usr/bin/env bash
#
# install-app.sh — install / refresh the Smart Mirror APP services + kiosk + mirrorctl.
#
# Companion to install.sh (which handles BLE WiFi provisioning). Idempotent: safe to
# re-run after pulling changes. Resolves the repo from this script's own path, rewrites
# each unit's paths/binaries to it, installs all 7 app/system units, the kiosk *user*
# service, the `mirrorctl` command, and the labwc autostart hook — then enables the
# stack for boot (full appliance).
#
#   Usage:  sudo ./provisioning/install-app.sh
#   After:  mirrorctl on        (bring it up now)
#           mirrorctl off       (turn it off for development)
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "This installer needs root for the system units. Re-running with sudo…" >&2
  exec sudo -- "$0" "$@"
fi

PROV="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"   # <repo>/mirror/provisioning
MIRROR_DIR="$(cd "$PROV/.." && pwd)"                      # <repo>/mirror
SYSD="/etc/systemd/system"

# The unprivileged session user owns the kiosk user-service + the labwc autostart.
RUN_USER="${SUDO_USER:-$(stat -c '%U' "$MIRROR_DIR")}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
RUN_UID="$(id -u "$RUN_USER")"

# Resolve binaries (install paths vary per system; fall back to the known Pi locations).
NODE_BIN="$(command -v node  || echo /usr/bin/node)"
SERVE_BIN="$(command -v serve || echo /usr/bin/serve)"
NGROK_BIN="$(command -v ngrok || echo /usr/local/bin/ngrok)"

echo "Repo (mirror):  $MIRROR_DIR"
echo "Session user:   $RUN_USER  ($RUN_HOME)"
echo "Binaries:       node=$NODE_BIN  serve=$SERVE_BIN  ngrok=$NGROK_BIN"
echo

# ── 1. App/system units: rewrite placeholders + legacy literal prefix, install ──
APP_UNITS=(
  smartmirror-backend.service
  smartmirror-ui.service
  smartmirror-sync.service
  smartmirror-ngrok.service
  smartmirror-classifier.service
  smartmirror-bgremover.service
  smartmirror-prefranker.service
)
for u in "${APP_UNITS[@]}"; do
  [[ -f "$PROV/$u" ]] || { echo "MISSING template: $PROV/$u" >&2; exit 1; }
  sed -e "s|__MIRROR_DIR__|$MIRROR_DIR|g" \
      -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__SERVE_BIN__|$SERVE_BIN|g" \
      -e "s|__NGROK_BIN__|$NGROK_BIN|g" \
      -e "s|/home/smartmirror/smart-mirror-final/mirror|$MIRROR_DIR|g" \
      "$PROV/$u" > "$SYSD/$u"
  echo "Installed $SYSD/$u"
done

# ── 2. mirrorctl → /usr/local/bin (symlink so repo edits are live) ──────────────
chmod +x "$PROV/mirrorctl"
ln -sfn "$PROV/mirrorctl" /usr/local/bin/mirrorctl
echo "Linked /usr/local/bin/mirrorctl → $PROV/mirrorctl"

# ── 3. Kiosk *user* service (owned by the session user) ─────────────────────────
USER_UNIT_DIR="$RUN_HOME/.config/systemd/user"
install -d -o "$RUN_USER" -g "$RUN_USER" "$USER_UNIT_DIR"
sed -e "s|__MIRROR_DIR__|$MIRROR_DIR|g" \
    "$PROV/smartmirror-kiosk.service" > "$USER_UNIT_DIR/smartmirror-kiosk.service"
chown "$RUN_USER:$RUN_USER" "$USER_UNIT_DIR/smartmirror-kiosk.service"
echo "Installed $USER_UNIT_DIR/smartmirror-kiosk.service"
sudo -u "$RUN_USER" XDG_RUNTIME_DIR="/run/user/$RUN_UID" systemctl --user daemon-reload || true

# ── 4. labwc autostart hook (fully managed; replaces the old lwrespawn line) ─────
AUTOSTART="$RUN_HOME/.config/labwc/autostart"
install -d -o "$RUN_USER" -g "$RUN_USER" "$(dirname "$AUTOSTART")"
cat > "$AUTOSTART" <<EOF
# Smart Mirror appliance autostart (managed by install-app.sh — do not hand-edit).
# Overrides /etc/xdg/labwc/autostart for the $RUN_USER account.

# Display/output configuration.
/usr/bin/kanshi &

# Kiosk browser — supervised by the smartmirror-kiosk systemd user service
# (Restart=always => crash recovery). Toggle WITHOUT editing this file:
#   mirrorctl on | off           (whole appliance)
#   mirrorctl kiosk on | off      (browser only)
# 'mirrorctl disable' sets the flag below so the kiosk stays off across reboots.
[ -e "\$HOME/.config/smartmirror/kiosk.disabled" ] || systemctl --user start smartmirror-kiosk.service
EOF
chown "$RUN_USER:$RUN_USER" "$AUTOSTART"
echo "Wrote $AUTOSTART"

# ── 5. Enable everything for boot (full appliance) ──────────────────────────────
systemctl daemon-reload
systemctl enable "${APP_UNITS[@]}"
# Keep BLE WiFi provisioning enabled too, if its unit is installed (don't recreate it —
# that's install.sh's job).
if [[ -f "$SYSD/smartmirror-ble-setup.service" ]]; then
  systemctl enable smartmirror-ble-setup.service || true
fi

echo
echo "Done — all app units enabled for boot."
echo "  Bring it up now:    mirrorctl on"
echo "  Turn it off (dev):  mirrorctl off"
echo "  Status:             mirrorctl status"
