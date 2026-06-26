#!/usr/bin/env bash
# ble-capture.sh — full BLE provisioning capture that survives an SSH/WiFi drop.
#
# Captures, into one timestamped session dir + tarball:
#   - btmon.snoop   : btsnoop HCI trace (open in Wireshark, frame-level OTA truth)
#   - btmon.txt     : btmon decoded text
#   - journal.log   : live journalctl for the BLE/bluetooth/network units
#   - ble-state.log : changes to /run/smartmirror/ble-state.json (state + pairing code)
#   - nmcli-state.log : changes to nmcli device state (captures the WiFi flip)
#   - 00-pre-snapshot.txt / 99-post-snapshot.txt : full before/after system state
#
# It re-execs itself detached (setsid, no controlling tty) so closing your SSH
# session or losing WiFi does NOT stop the capture.
#
# Usage:
#   sudo ble-capture.sh [--start-reprovision] [--duration SECONDS]
#     --start-reprovision  also start smartmirror-ble-reprovision.service (--force advertising)
#     --duration N         auto-stop after N seconds (default 1200; > the 900s advert window)
#
# Stop early with:  sudo ble-stop.sh        Watch live with:  ble-watch.sh
set -uo pipefail

SELF="$(readlink -f "$0")"
DIR="$(dirname "$SELF")"

usage() { sed -n '2,18p' "$SELF" | sed 's/^# \{0,1\}//'; }
for a in "$@"; do [[ "$a" == "-h" || "$a" == "--help" ]] && { usage; exit 0; }; done

# ---------------------------------------------------------------------------
# Parent: validate, make the session dir, then re-exec ourselves detached.
# ---------------------------------------------------------------------------
if [[ "${BLE_DIAG_DETACHED:-}" != "1" ]]; then
  if [[ $EUID -ne 0 ]]; then
    echo "ble-capture: must run as root (btmon + systemctl).  Try: sudo $SELF $*" >&2
    exit 1
  fi
  TS="$(date +%Y%m%d-%H%M%S)"
  RUN_USER="${SUDO_USER:-smartmirror}"
  USER_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"; USER_HOME="${USER_HOME:-/home/smartmirror}"
  BASE="$USER_HOME/ble-diag-logs"
  SESSION="$BASE/ble-$TS"
  mkdir -p "$SESSION"
  chown "$RUN_USER":"$RUN_USER" "$BASE" "$SESSION" 2>/dev/null || true

  echo "[ble-capture] session : $SESSION"
  echo "[ble-capture] detaching (survives SSH / WiFi drop)…"
  BLE_DIAG_DETACHED=1 BLE_DIAG_SESSION="$SESSION" BLE_DIAG_RUNUSER="$RUN_USER" \
    setsid "$SELF" "$@" >"$SESSION/runner.log" 2>&1 </dev/null &
  echo "$SESSION" > /tmp/ble-capture.session
  sleep 1
  echo "[ble-capture] running. logs stream into the session dir above."
  echo "[ble-capture] stop & bundle : sudo $DIR/ble-stop.sh"
  echo "[ble-capture] live view     : $DIR/ble-watch.sh"
  echo "[ble-capture] runner log    : $SESSION/runner.log"
  exit 0
fi

# ---------------------------------------------------------------------------
# Detached child.
# ---------------------------------------------------------------------------
SESSION="$BLE_DIAG_SESSION"
RUN_USER="$BLE_DIAG_RUNUSER"
echo $$ > /tmp/ble-capture.pid

DURATION=1200
START_REPROV=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --start-reprovision) START_REPROV=1; shift;;
    --duration) DURATION="${2:?}"; shift 2;;
    --duration=*) DURATION="${1#*=}"; shift;;
    *) echo "[ble-capture] ignoring unknown arg: $1"; shift;;
  esac
done

UNITS=(
  smartmirror-ble-setup.service
  smartmirror-ble-reprovision.service
  smartmirror-ble-reprovision-trigger.service
  smartmirror-ble-reprovision-trigger.path
  bluetooth.service
  NetworkManager.service
  wpa_supplicant.service
)

snapshot() {
  echo "===== $1 ($(date '+%Y-%m-%d %H:%M:%S %z')) ====="
  echo;  echo "--- uname ---";              uname -a
  echo;  echo "--- bluez version ---";      bluetoothctl --version
  echo;  echo "--- bluetoothctl show ---";  bluetoothctl show 2>&1
  echo;  echo "--- hciconfig -a ---";       hciconfig -a 2>&1
  echo;  echo "--- rfkill ---";             rfkill list 2>&1
  echo;  echo "--- nmcli dev status ---";   nmcli dev status 2>&1
  echo;  echo "--- nmcli wifi list ---";    nmcli -f SSID,SECURITY,SIGNAL dev wifi 2>&1 | head -40
  echo;  echo "--- nmcli con show ---";     nmcli con show 2>&1
  echo;  echo "--- ip -brief addr ---";     ip -brief addr 2>&1
  echo;  echo "--- ble-state.json ---";     cat /run/smartmirror/ble-state.json 2>&1 || echo "(none)"
  echo;  echo "--- systemctl status (units) ---"
  systemctl --no-pager --full status "${UNITS[@]}" 2>&1 | sed -n '1,120p'
  echo;  echo "--- git (both repos) ---"
  git -C /home/smartmirror/UI-smart-mirror     log --oneline -1 2>&1
  git -C /home/smartmirror/UI-smart-mirror     status --short  2>&1
  git -C /home/smartmirror/Smart_Mirror_Program log --oneline -1 2>&1
}

{
  echo "session   : $SESSION"
  echo "started   : $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "duration  : ${DURATION}s"
  echo "reprovision_on_start : $START_REPROV"
  echo "pid       : $$"
} > "$SESSION/session-info.txt"

snapshot "PRE-SNAPSHOT" > "$SESSION/00-pre-snapshot.txt" 2>&1

# --- collectors -------------------------------------------------------------
btmon -w "$SESSION/btmon.snoop" > "$SESSION/btmon.txt" 2>&1 &
BTMON_PID=$!

journalctl -f -n 0 -o short-precise \
  -u smartmirror-ble-setup.service \
  -u smartmirror-ble-reprovision.service \
  -u smartmirror-ble-reprovision-trigger.service \
  -u smartmirror-ble-reprovision-trigger.path \
  -u bluetooth.service \
  -u NetworkManager.service \
  -u wpa_supplicant.service \
  > "$SESSION/journal.log" 2>&1 &
JOURNAL_PID=$!

# BLE state-file sampler (0.5s) — logs full JSON whenever a material field changes.
python3 - "$SESSION/ble-state.log" <<'PY' &
import json, sys, time
path = "/run/smartmirror/ble-state.json"
out  = open(sys.argv[1], "a", buffering=1)
last = object()
def stamp(): return time.strftime("%H:%M:%S")
while True:
    try:
        with open(path) as f:
            d = json.load(f)
        key = (d.get("btName"), d.get("state"), d.get("pairingState"), d.get("pairingCode"))
        if key != last:
            out.write("%s %s\n" % (stamp(), json.dumps(d, separators=(",", ":"))))
            last = key
    except FileNotFoundError:
        if last != "__none__":
            out.write("%s (no state file)\n" % stamp()); last = "__none__"
    except Exception:
        pass
    time.sleep(0.5)
PY
STATE_PID=$!

# nmcli device-state sampler (1s) — captures the WiFi disconnect/reconnect flip.
(
  last=""
  while true; do
    cur="$(nmcli -t -f DEVICE,STATE,CONNECTION dev status 2>/dev/null | tr '\n' '|')"
    if [[ "$cur" != "$last" ]]; then
      printf '%s %s\n' "$(date +%H:%M:%S)" "$cur" >> "$SESSION/nmcli-state.log"
      last="$cur"
    fi
    sleep 1
  done
) &
NMCLI_PID=$!

echo "[ble-capture] collectors up: btmon=$BTMON_PID journal=$JOURNAL_PID state=$STATE_PID nmcli=$NMCLI_PID"

if [[ "$START_REPROV" == "1" ]]; then
  echo "[ble-capture] starting smartmirror-ble-reprovision.service (--force advertising)…"
  systemctl start smartmirror-ble-reprovision.service \
    && echo "[ble-capture] reprovision service started." \
    || echo "[ble-capture] WARNING: failed to start reprovision service."
fi

# --- teardown ---------------------------------------------------------------
cleanup() {
  trap '' TERM INT
  echo "[ble-capture] tearing down ($(date '+%H:%M:%S'))…"
  snapshot "POST-SNAPSHOT" > "$SESSION/99-post-snapshot.txt" 2>&1
  for p in "$BTMON_PID" "$JOURNAL_PID" "$STATE_PID" "$NMCLI_PID"; do kill "$p" 2>/dev/null; done
  sleep 1
  for p in "$BTMON_PID" "$JOURNAL_PID" "$STATE_PID" "$NMCLI_PID"; do kill -9 "$p" 2>/dev/null; done
  tar -czf "$SESSION.tar.gz" -C "$(dirname "$SESSION")" "$(basename "$SESSION")" 2>/dev/null
  chown -R "$RUN_USER":"$RUN_USER" "$SESSION" "$SESSION.tar.gz" 2>/dev/null || true
  rm -f /tmp/ble-capture.pid
  echo "[ble-capture] DONE."
  echo "[ble-capture] bundle: $SESSION.tar.gz"
  exit 0
}
trap cleanup TERM INT

echo "[ble-capture] capturing for up to ${DURATION}s — Ctrl-C here or run ble-stop.sh to finish."
sleep "$DURATION" &
wait $!
cleanup
