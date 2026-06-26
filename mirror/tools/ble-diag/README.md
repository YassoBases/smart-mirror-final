# BLE provisioning test & diagnostics toolkit

Pi-side capture for testing the BLE WiFi-provisioning flow between the mirror
(`UI-smart-mirror`, this Pi) and the Android app (`Smart_Mirror_Program`).

Everything is **self-contained and offline-friendly**: capture survives an
SSH/WiFi drop, writes plain files, and bundles one `.tar.gz` per session under
`~/ble-diag-logs/`. A later Claude session (no internet) can read those files
directly to diagnose.

## Scripts

| Script | Run as | What it does |
|---|---|---|
| `ble-capture.sh` | `sudo` | Detaches (survives SSH drop) and records btmon (btsnoop + text), journald, the BLE state file, and nmcli state. `--start-reprovision` also starts the `--force` advertising service. `--duration N` (default 1200s). |
| `ble-stop.sh` | `sudo` | Ends the running capture early and writes the tarball. |
| `ble-watch.sh` | user | Read-only live dashboard (state, pairing code, services, wifi, journal tail). |
| `ble-collect.sh` | `sudo` | After-the-fact collection from persistent journald (use after an offline-boot test). `--since "30 min ago"`. |

Output per session: `00-pre-snapshot.txt`, `btmon.snoop`, `btmon.txt`,
`journal.log`, `ble-state.log`, `nmcli-state.log`, `99-post-snapshot.txt`,
`runner.log`, `session-info.txt` → bundled as `ble-<timestamp>.tar.gz`.

## GATT contract (for reading the trace)

- Service `4fafc201-1fb5-459e-8fcc-c5c9c3319143`
- Networks (read/notify) `beb5483e-36e1-4688-b7f5-ea07361b26a8`
- Credentials (**encrypt-write**, JSON `{ssid,password}`) `a9b1c2d3-e4f5-6789-abcd-ef0123456789`
- Status (notify, JSON `{state,ip,apiBaseUrl}`) `c0d1e2f3-a4b5-6789-cdef-012345678901`
- Advertised name: `Smart Mirror <last-4-of-BT-MAC>` (this Pi: **Smart Mirror F62C**)
- Pairing: LE Secure Connections **numeric comparison** — mirror auto-confirms and
  publishes the 6-digit code; the phone shows the same code (tap Pair).

## Test stages

### Stage 0 — verify the tools first
```bash
./ble-watch.sh                                   # renders? Ctrl-C
sudo ./ble-capture.sh --duration 15              # detaches, no reprovision
ls -lh ~/ble-diag-logs/                          # expect ble-<ts>/ and ble-<ts>.tar.gz
```

### Stage 1 — same-network smoke test (SSH should survive)
```bash
sudo ./ble-capture.sh --start-reprovision
./ble-watch.sh        # optional, 2nd pane / mirror console
```
Phone: onboarding BLE setup → **Find my mirror** → pick **Smart Mirror F62C** →
confirm the **6-digit code matches** → Pair → pick **HFKFNMC_Deco** → password → submit.
```bash
sudo ./ble-stop.sh    # prints the .tar.gz
```

### Stage 2 — switch to a different network (SSH WILL drop)
Start capture detached first, then provision a *different* SSID (e.g. phone hotspot).
SSH dies when wlan0 leaves the current network — expected; capture keeps logging.
Reconnect to the mirror's new IP (shown on screen / in the app), then `sudo ./ble-stop.sh`.
Reprovision back to `HFKFNMC_Deco` afterward to restore your working network.

### Stage 3 — realistic offline boot (SSH lost until reprovisioned)
Best from a keyboard on the mirror console.
```bash
nmcli con show
sudo nmcli con delete "HFKFNMC_Deco"     # (+ other wifi profiles) — drops SSH
sudo reboot
```
Mirror enters setup mode at boot (after the 30s nm-online grace); provision from the app.
After it's back online:
```bash
sudo ./ble-collect.sh --since "30 min ago"
```
For a full btmon trace of stage 3, run `sudo ./ble-capture.sh` from the mirror console
once it's advertising, then pair.

## "Flawless" checklist (per run)

1. **Advertising** — app finds "Smart Mirror F62C"; `btmon.txt` shows ADV with the name.
2. **Pairing** — mirror code == phone dialog code; bond completes (btmon SMP ok; journal `RequestConfirmation`).
3. **Networks** — app shows the network list; pairing code clears.
4. **Credentials** — submit → `ble-state.log` shows `state=connecting`; journal shows `nmcli … connect`.
5. **Join** — `state=connected` with `ip`/`apiBaseUrl`; app advances; `nmcli-state.log` shows wlan0 connected.

## Symptom → which artifact

- Can't find mirror → `btmon.txt` (ADV going out?), `00-pre-snapshot.txt` (hci0 UP? rfkill?), `journal.log` (advert registered?).
- Pairing fails → `btmon.txt` (SMP), `journal.log` (agent / error 62 stale-bond), `ble-state.log` (code published?).
- Write rejected → `btmon.txt` — Credentials char is `encrypt-write`, so a failed bond blocks it.
- Won't join WiFi → `journal.log` (NetworkManager/wpa_supplicant), `nmcli-state.log`, `ble-state.log` (`state=failed`).
- App times out after join → `ble-state.log` (did `connected`+`apiBaseUrl` land within the app's 35s watchdog?), `99-post-snapshot.txt`.

## Reading captures offline / later

- `btmon.snoop` opens in **Wireshark** (btsnoop). `btmon.txt` is the decoded text version.
- Everything else is plain text. Hand the `.tar.gz` path to a later Claude session for analysis.

## Notes

- `btmgmt` is intentionally avoided (hangs non-interactively); adapter state via `hciconfig`/`bluetoothctl show`.
- Optional: plug Ethernet into the Pi for a stable out-of-band SSH path during stages 2–3.
- These tools are untracked (not committed). Ask if you want them added to the repo.
