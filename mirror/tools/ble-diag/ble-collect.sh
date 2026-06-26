#!/usr/bin/env bash
# ble-collect.sh — after-the-fact log collection (no live capture was running).
# Use this after a reboot / offline-boot test: persistent journald retained the
# boot-time setup logs even though btmon was not running.
#
# Usage:  sudo ble-collect.sh [--since "30 min ago"]
set -uo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ble-collect: must run as root.  Try: sudo $(readlink -f "$0") $*" >&2
  exit 1
fi

SINCE="1 hour ago"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)   SINCE="${2:?}"; shift 2;;
    --since=*) SINCE="${1#*=}"; shift;;
    -h|--help) echo "usage: sudo ble-collect.sh [--since \"30 min ago\"]"; exit 0;;
    *) echo "ble-collect: ignoring unknown arg: $1"; shift;;
  esac
done

TS="$(date +%Y%m%d-%H%M%S)"
RUN_USER="${SUDO_USER:-smartmirror}"
USER_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"; USER_HOME="${USER_HOME:-/home/smartmirror}"
BASE="$USER_HOME/ble-diag-logs"
SESSION="$BASE/collect-$TS"
mkdir -p "$SESSION"

UNITS=(
  smartmirror-ble-setup.service
  smartmirror-ble-reprovision.service
  smartmirror-ble-reprovision-trigger.service
  smartmirror-ble-reprovision-trigger.path
  bluetooth.service
  NetworkManager.service
  wpa_supplicant.service
)

echo "[ble-collect] gathering journal since: $SINCE"
journalctl --since "$SINCE" -o short-precise \
  -u smartmirror-ble-setup.service \
  -u smartmirror-ble-reprovision.service \
  -u smartmirror-ble-reprovision-trigger.service \
  -u smartmirror-ble-reprovision-trigger.path \
  -u bluetooth.service \
  -u NetworkManager.service \
  -u wpa_supplicant.service \
  > "$SESSION/journal-since.log" 2>&1

{
  echo "===== SNAPSHOT ($(date '+%Y-%m-%d %H:%M:%S %z'))  since=$SINCE ====="
  echo;  echo "--- uname ---";              uname -a
  echo;  echo "--- bluez version ---";      bluetoothctl --version
  echo;  echo "--- bluetoothctl show ---";  bluetoothctl show 2>&1
  echo;  echo "--- hciconfig -a ---";       hciconfig -a 2>&1
  echo;  echo "--- rfkill ---";             rfkill list 2>&1
  echo;  echo "--- nmcli dev status ---";   nmcli dev status 2>&1
  echo;  echo "--- nmcli con show ---";     nmcli con show 2>&1
  echo;  echo "--- ip -brief addr ---";     ip -brief addr 2>&1
  echo;  echo "--- systemctl status ---";   systemctl --no-pager --full status "${UNITS[@]}" 2>&1 | sed -n '1,140p'
  echo;  echo "--- git (both repos) ---"
  git -C /home/smartmirror/UI-smart-mirror      log --oneline -1 2>&1
  git -C /home/smartmirror/UI-smart-mirror      status --short  2>&1
  git -C /home/smartmirror/Smart_Mirror_Program log --oneline -1 2>&1
} > "$SESSION/snapshot.txt" 2>&1

cat /run/smartmirror/ble-state.json > "$SESSION/ble-state.json" 2>/dev/null \
  || echo "(no /run/smartmirror/ble-state.json at collection time)" > "$SESSION/ble-state.json"

dmesg -T 2>/dev/null | grep -iE 'blue|hci|wlan|firmware|brcm' > "$SESSION/dmesg-bt.log" 2>&1

tar -czf "$SESSION.tar.gz" -C "$BASE" "$(basename "$SESSION")" 2>/dev/null
chown -R "$RUN_USER":"$RUN_USER" "$BASE" 2>/dev/null || true

echo "[ble-collect] DONE."
echo "[ble-collect] bundle: $SESSION.tar.gz"
ls -lh "$SESSION.tar.gz"
