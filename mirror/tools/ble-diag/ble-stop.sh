#!/usr/bin/env bash
# ble-stop.sh — stop a running ble-capture.sh session and bundle its tarball.
set -uo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ble-stop: must run as root.  Try: sudo $(readlink -f "$0")" >&2
  exit 1
fi

PIDF=/tmp/ble-capture.pid
SESSF=/tmp/ble-capture.session

if [[ ! -f "$PIDF" ]]; then
  echo "ble-stop: no capture appears to be running (missing $PIDF)."
  echo "          (a finished capture already wrote its tarball; check ~/ble-diag-logs/)"
  exit 1
fi

PID="$(cat "$PIDF" 2>/dev/null)"
SESS="$(cat "$SESSF" 2>/dev/null)"

if ! kill -0 "$PID" 2>/dev/null; then
  echo "ble-stop: capture PID $PID is not alive; cleaning up stale pidfile."
  rm -f "$PIDF"
  [[ -n "$SESS" && -f "$SESS.tar.gz" ]] && echo "ble-stop: existing bundle: $SESS.tar.gz"
  exit 1
fi

echo "[ble-stop] signaling capture PID $PID to finish…"
kill -TERM "$PID" 2>/dev/null

# Wait for the teardown to produce the tarball.
for _ in $(seq 1 30); do
  [[ -n "$SESS" && -f "$SESS.tar.gz" ]] && break
  sleep 0.5
done

if [[ -n "$SESS" && -f "$SESS.tar.gz" ]]; then
  echo "[ble-stop] DONE."
  echo "[ble-stop] bundle: $SESS.tar.gz"
  ls -lh "$SESS.tar.gz"
else
  echo "[ble-stop] stop signaled. Bundle not visible yet — check: ${SESS:-~/ble-diag-logs/}"
fi
