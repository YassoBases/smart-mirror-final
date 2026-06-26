#!/usr/bin/env bash
# ble-watch.sh — read-only live dashboard for a BLE provisioning test.
# Safe to run over SSH or, better, on a keyboard attached to the mirror's
# console (immune to WiFi drops). No root needed. Ctrl-C to exit.
set -uo pipefail

UNITS=(
  smartmirror-ble-setup.service
  smartmirror-ble-reprovision.service
  smartmirror-ble-reprovision-trigger.path
  bluetooth.service
)

while true; do
  clear
  echo "==== BLE provisioning watch  $(date '+%H:%M:%S')  ====   (Ctrl-C to exit)"
  echo
  echo "-- mirror state  (/run/smartmirror/ble-state.json) --"
  python3 - <<'PY'
import json
try:
    d = json.load(open("/run/smartmirror/ble-state.json"))
    print("  btName       : %s" % d.get("btName"))
    print("  state        : %s" % d.get("state"))
    print("  pairingState : %s" % d.get("pairingState"))
    code = d.get("pairingCode")
    print("  pairingCode  : %s" % ("   ".join(code) if code else "(none)"))
    for k in ("ip", "apiBaseUrl"):
        if d.get(k): print("  %-12s : %s" % (k, d[k]))
except FileNotFoundError:
    print("  (no state file yet — daemon not advertising)")
except Exception as e:
    print("  (unreadable: %s)" % e)
PY
  echo
  echo "-- services --"
  for u in "${UNITS[@]}"; do
    printf "  %-46s %s\n" "$u" "$(systemctl is-active "$u" 2>/dev/null)"
  done
  echo
  echo "-- adapter / wifi --"
  printf "  hci0  : %s\n" "$(hciconfig hci0 2>/dev/null | grep -oE '(UP|DOWN) RUNNING.*|UP\b.*' | head -1)"
  printf "  wlan0 : %s\n" "$(nmcli -t -f DEVICE,STATE,CONNECTION dev status 2>/dev/null | awk -F: '$1=="wlan0"{print $2"  "$3}')"
  printf "  ip    : %s\n" "$(ip -brief addr show wlan0 2>/dev/null | awk '{print $3}')"
  echo
  echo "-- last journal lines (setup + reprovision) --"
  journalctl -n 8 --no-pager -o short-precise \
    -u smartmirror-ble-reprovision.service \
    -u smartmirror-ble-setup.service 2>/dev/null | sed 's/^/  /'
  sleep 1
done
