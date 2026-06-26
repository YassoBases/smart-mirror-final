#!/usr/bin/env python3
"""
Smart Mirror BLE WiFi provisioning daemon.
Runs at Pi boot via smartmirror-ble-setup.service.
Exits immediately if the Pi is already online.

GATT service:
  Service UUID:     4fafc201-1fb5-459e-8fcc-c5c9c3319143
  Networks  char:   beb5483e-36e1-4688-b7f5-ea07361b26a8  (read / notify)
  Credentials char: a9b1c2d3-e4f5-6789-abcd-ef0123456789  (write, encrypt-write)
  Status char:      c0d1e2f3-a4b5-6789-cdef-012345678901  (read / notify, encrypt-read)

Requirements:
  pip3 install bluezero
  sudo apt install bluez python3-gi python3-dbus network-manager
  sudo systemctl enable bluetooth
"""

import argparse
import json
import logging
import os
import socket
import subprocess
import sys
import threading
import time

import dbus
import dbus.exceptions
import dbus.service
from gi.repository import GLib  # python3-gi / gir1.2-glib-2.0

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [ble-setup] %(levelname)s %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger(__name__)

# Shared GATT UUIDs — must match mirror_ble_provisioner.dart in the phone app.
SERVICE_UUID     = '4fafc201-1fb5-459e-8fcc-c5c9c3319143'
NETWORKS_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26a8'
CREDENTIALS_UUID = 'a9b1c2d3-e4f5-6789-abcd-ef0123456789'
STATUS_UUID      = 'c0d1e2f3-a4b5-6789-cdef-012345678901'


# ---------------------------------------------------------------------------
# UI state file — the only channel from this root daemon to the React mirror UI
# ---------------------------------------------------------------------------
# The non-root Node backend reads this file and serves it at GET /api/mirror/ble-status;
# the React UI (SetupMode / PairingCodeOverlay) polls that endpoint. We reuse the
# privilege-separated /run/smartmirror dir already created by the tmpfiles unit.

UI_STATE_DIR  = '/run/smartmirror'
UI_STATE_FILE = UI_STATE_DIR + '/ble-state.json'


class _UiState:
    """Thread-safe writer for the daemon → mirror-UI handoff file."""

    def __init__(self):
        self._lock = threading.Lock()
        self._data = {
            'btName': '',
            'state': 'idle',
            'pairingCode': None,
            'pairingState': 'idle',
        }

    def _flush(self) -> None:
        self._data['updatedAt'] = int(time.time())
        try:
            os.makedirs(UI_STATE_DIR, exist_ok=True)
            tmp = UI_STATE_FILE + '.tmp'
            with open(tmp, 'w') as f:
                json.dump(self._data, f)
            os.replace(tmp, UI_STATE_FILE)      # atomic swap
            os.chmod(UI_STATE_FILE, 0o644)      # let the non-root backend read it
        except Exception as e:
            log.warning('Could not write UI state file: %s', e)

    def set_name(self, name: str) -> None:
        with self._lock:
            self._data['btName'] = name
            self._flush()

    def set_status(self, state: str) -> None:
        with self._lock:
            self._data['state'] = state
            # Any post-bond state means pairing is over — drop the code.
            if state in ('connecting', 'connected', 'failed'):
                self._data['pairingCode'] = None
                self._data['pairingState'] = 'idle'
            self._flush()

    def set_pairing(self, code: str) -> None:
        with self._lock:
            self._data['pairingCode'] = code
            self._data['pairingState'] = 'pairing'
            self._flush()

    def clear_pairing(self) -> None:
        with self._lock:
            self._data['pairingCode'] = None
            self._data['pairingState'] = 'idle'
            self._flush()


ui_state = _UiState()


# ---------------------------------------------------------------------------
# Pairing agent — numeric comparison (visible 6-digit code)
# ---------------------------------------------------------------------------
# The Credentials/Status characteristics use encrypt-write/encrypt-read, so BlueZ
# bonds the link before the phone can send the password. We register our own agent
# with capability DisplayYesNo so bonding uses LE Secure Connections *numeric
# comparison*: BlueZ hands us a 6-digit passkey via RequestConfirmation, we publish
# it to the mirror UI (so the user can check it matches the code their phone shows)
# and auto-confirm — the mirror has no input during setup, so the human confirms on
# the phone. This adds MITM protection over the old silent "Just Works" pairing.

ONLINE_GRACE_SECS = 30

AGENT_IFACE = 'org.bluez.Agent1'
AGENT_PATH  = '/com/smartmirror/agent'
AGENT_CAP   = 'DisplayYesNo'
BLUEZ_SVC   = 'org.bluez'


# Classic BR/EDR audio/telephony profile short-UUIDs that Android auto-connects
# right after LE bonding (dual-mode hijack). Rejected during provisioning so the
# BLE GATT link stays free; classic BT is unaffected outside this agent's scope.
_CLASSIC_AUDIO_UUIDS = frozenset({
    '1108', '1112',   # HSP (Headset, Headset HS)
    '111e', '111f',   # HFP (Handsfree, Handsfree AG)
    '110a', '110b',   # A2DP (Audio Source, Audio Sink)
    '110c', '110d',   # A/V Remote Control (Target, Remote Control)
    '110e', '110f',   # A/V Remote Control (Controller)
    '112d',           # SIM Access Profile
})


class _NumericComparisonAgent(dbus.service.Object):
    """org.bluez.Agent1 (DisplayYesNo): publishes the pairing passkey to the mirror
    UI and auto-confirms, so bonding uses numeric comparison with a visible code."""

    @dbus.service.method(AGENT_IFACE, in_signature='', out_signature='')
    def Release(self):
        log.info('Pairing agent released')
        ui_state.clear_pairing()

    @dbus.service.method(AGENT_IFACE, in_signature='os', out_signature='')
    def AuthorizeService(self, device, uuid):
        short = uuid[4:8].lower()
        if short in _CLASSIC_AUDIO_UUIDS:
            log.info('AuthorizeService %s %s -> reject (classic audio during BLE setup)', device, uuid)
            raise dbus.exceptions.DBusException(
                'Rejected: classic audio profiles blocked during BLE provisioning',
                name='org.bluez.Error.Rejected',
            )
        log.info('AuthorizeService %s %s -> allow', device, uuid)

    @dbus.service.method(AGENT_IFACE, in_signature='o', out_signature='s')
    def RequestPinCode(self, device):
        return '0000'  # legacy BR/EDR only; unused for BLE

    @dbus.service.method(AGENT_IFACE, in_signature='o', out_signature='u')
    def RequestPasskey(self, device):
        return dbus.UInt32(0)

    @dbus.service.method(AGENT_IFACE, in_signature='ouq', out_signature='')
    def DisplayPasskey(self, device, passkey, entered):
        # Passkey-entry fallback (peer asked us to display): show it on the mirror.
        code = '%06d' % int(passkey)
        log.info('DisplayPasskey %s -> %s', device, code)
        ui_state.set_pairing(code)

    @dbus.service.method(AGENT_IFACE, in_signature='os', out_signature='')
    def DisplayPinCode(self, device, pincode):
        pass

    @dbus.service.method(AGENT_IFACE, in_signature='ou', out_signature='')
    def RequestConfirmation(self, device, passkey):
        # Numeric comparison: show the 6-digit code on the mirror so the user can
        # check it matches the code their phone shows, then auto-confirm (the mirror
        # has no setup-time input; the human confirms on the phone). Returning
        # normally accepts the pairing.
        code = '%06d' % int(passkey)
        log.info('RequestConfirmation %s passkey=%s -> show + auto-confirm', device, code)
        ui_state.set_pairing(code)

    @dbus.service.method(AGENT_IFACE, in_signature='o', out_signature='')
    def RequestAuthorization(self, device):
        log.info('RequestAuthorization %s -> allow', device)

    @dbus.service.method(AGENT_IFACE, in_signature='', out_signature='')
    def Cancel(self):
        log.info('Pairing cancelled by remote')
        ui_state.clear_pairing()


def _register_agent():
    """Register the silent agent as the system default. Returns the agent object,
    which must be kept referenced for the lifetime of the process."""
    bus = dbus.SystemBus()
    agent = _NumericComparisonAgent(bus, AGENT_PATH)
    mgr = dbus.Interface(bus.get_object(BLUEZ_SVC, '/org/bluez'),
                         'org.bluez.AgentManager1')
    mgr.RegisterAgent(AGENT_PATH, AGENT_CAP)
    try:
        mgr.RequestDefaultAgent(AGENT_PATH)
    except dbus.DBusException as e:
        # A desktop session may already hold the default agent; RegisterAgent still
        # routes the bonding for our device to us, so this is non-fatal.
        log.warning('RequestDefaultAgent failed (%s); registered agent stands.', e)
    return agent


def _remove_known_devices():
    """Remove all paired/known devices so stale bonds don't block re-pairing."""
    bus = dbus.SystemBus()
    try:
        om = dbus.Interface(bus.get_object(BLUEZ_SVC, '/'),
                            'org.freedesktop.DBus.ObjectManager')
        objects = om.GetManagedObjects()
    except dbus.DBusException as e:
        log.warning('Could not enumerate BlueZ objects: %s', e)
        return
    removed = 0
    for path, ifaces in objects.items():
        if 'org.bluez.Device1' not in ifaces:
            continue
        adapter_path = ifaces['org.bluez.Device1'].get('Adapter', '/org/bluez/hci0')
        try:
            adapter = dbus.Interface(bus.get_object(BLUEZ_SVC, adapter_path),
                                     'org.bluez.Adapter1')
            adapter.RemoveDevice(path)
            removed += 1
        except dbus.DBusException as e:
            log.debug('RemoveDevice(%s) failed: %s', path, e)
    log.info('Cleared %d known device(s) before advertising.', removed)


# ---------------------------------------------------------------------------
# NetworkManager helpers
# ---------------------------------------------------------------------------

def _nm_wait(timeout: int = 30) -> bool:
    """Block until NetworkManager is running (max timeout seconds)."""
    for _ in range(timeout):
        try:
            r = subprocess.run(
                ['nmcli', '-t', '-f', 'STATE', 'g'],
                capture_output=True, text=True, timeout=3,
            )
            if r.returncode == 0 and r.stdout.strip():
                return True
        except Exception:
            pass
        time.sleep(1)
    return False


def _nm_is_online() -> bool:
    # nmcli CONNECTIVITY is stale when queried as root — use kernel-level checks instead.
    try:
        r = subprocess.run(['iw', 'dev', 'wlan0', 'link'],
                           capture_output=True, text=True, timeout=5)
        if 'Connected to' in r.stdout:
            return True
    except Exception:
        pass
    try:
        # Ethernet fallback
        r = subprocess.run(['ip', 'route', 'show', 'default'],
                           capture_output=True, text=True, timeout=5)
        for line in r.stdout.splitlines():
            if 'eth' in line:
                return True
    except Exception:
        pass
    return False


def _wait_for_online(timeout: int) -> bool:
    """Give NetworkManager time to bring up a saved network at boot before
    concluding the Pi needs provisioning. nm-online -s returns the instant NM
    finishes its autoconnect attempts, so a genuine first-boot (nothing saved)
    still enters setup promptly."""
    try:
        subprocess.run(['nm-online', '-s', '-t', str(timeout)],
                       capture_output=True, timeout=timeout + 5)
    except Exception:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if _nm_is_online():
                return True
            time.sleep(2)
    return _nm_is_online()


def _scan_networks() -> list:
    """Return [{ssid, secured}] via nmcli. Deduplicates SSIDs."""
    try:
        r = subprocess.run(
            ['nmcli', '-t', '-f', 'SSID,SECURITY', 'dev', 'wifi'],
            capture_output=True, text=True, timeout=15,
        )
        seen, nets = set(), []
        for line in r.stdout.splitlines():
            parts = line.split(':', 1)
            if len(parts) != 2:
                continue
            ssid, security = parts[0].strip(), parts[1].strip()
            if not ssid or ssid in seen:
                continue
            seen.add(ssid)
            nets.append({'ssid': ssid, 'secured': bool(security and security != '--')})
        return nets
    except Exception:
        return []


def _get_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80))
            return s.getsockname()[0]
    except Exception:
        return ''


def _connect_wifi(ssid: str, password: str) -> tuple:
    # Remove any stale profile so nmcli creates a fresh one (avoids key-mgmt mismatch errors).
    subprocess.run(
        ['nmcli', 'connection', 'delete', 'id', ssid],
        capture_output=True, text=True, timeout=5,
    )
    cmd = ['nmcli', 'dev', 'wifi', 'connect', ssid]
    if password:
        cmd += ['password', password]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            return True, ''
        return False, (r.stderr.strip() or r.stdout.strip())
    except subprocess.TimeoutExpired:
        return False, 'Connection timed out.'
    except Exception as e:
        return False, str(e)


def _bt_short_id() -> str:
    """Return the last 4 hex chars of the BT adapter MAC (e.g. 'A1B2')."""
    try:
        r = subprocess.run(
            ['bluetoothctl', 'show'], capture_output=True, text=True, timeout=5,
        )
        for line in r.stdout.splitlines():
            if 'Controller' in line:
                mac = line.split()[1]
                return mac.replace(':', '')[-4:].upper()
    except Exception:
        pass
    return '0000'


def _enc(obj) -> list:
    """JSON-encode obj and return as list of ints (byte array for bluezero)."""
    return list(json.dumps(obj).encode())


# ---------------------------------------------------------------------------
# BLE GATT peripheral
# ---------------------------------------------------------------------------

class _BleProvisioner:
    def __init__(self, adapter_addr: str, force: bool = False):
        from bluezero import peripheral

        dev_name = f'Smart Mirror {_bt_short_id()}'
        log.info('BLE device name: "%s"', dev_name)
        ui_state.set_name(dev_name)   # surface the real name to the mirror UI

        self._p = peripheral.Peripheral(adapter_addr, local_name=dev_name)
        self._p.add_service(srv_id=1, uuid=SERVICE_UUID, primary=True)

        self._networks: list = _enc([])
        self._status: list   = _enc({'state': 'idle'})
        # Snapshots pinned on each offset-0 read so a concurrent rescan swapping
        # self._networks can't corrupt an in-flight Read Blob reassembly.
        self._net_read_buf: list    = self._networks
        self._status_read_buf: list = self._status

        # Networks — phone reads the list of SSIDs the Pi can see.
        self._p.add_characteristic(
            srv_id=1, chr_id=1,
            uuid=NETWORKS_UUID,
            value=self._networks,
            notifying=False,
            flags=['read', 'notify'],
            read_callback=self._read_networks,
            write_callback=None,
            notify_callback=None,
        )
        self._networks_char = self._p.characteristics[-1]

        # Credentials — phone writes {ssid, password}.
        # encrypt-write forces the link to be bonded/encrypted before the write
        # is accepted, so the WiFi password never travels over plaintext BLE.
        self._p.add_characteristic(
            srv_id=1, chr_id=2,
            uuid=CREDENTIALS_UUID,
            value=[],
            notifying=False,
            flags=['write', 'encrypt-write'],
            read_callback=None,
            write_callback=self._on_credentials_write,
            notify_callback=None,
        )
        # Status — phone subscribes to know when the Pi has connected.
        # Returns {state, ip, apiBaseUrl} on success so the app can skip QR scanning.
        self._p.add_characteristic(
            srv_id=1, chr_id=3,
            uuid=STATUS_UUID,
            value=self._status,
            notifying=False,
            flags=['read', 'notify', 'encrypt-read'],
            read_callback=self._read_status,
            write_callback=None,
            notify_callback=None,
        )
        self._status_char = self._p.characteristics[-1]

        self._force = force
        self._wake = threading.Event()   # set when the phone writes credentials
        self._pending = None             # dict of the last-written credentials
        self._lock = threading.Lock()
        self._start = time.monotonic()
        self._agent = None               # keep the pairing agent referenced

    # Called from the GLib event-loop thread when the phone writes credentials.
    def _on_credentials_write(self, value, options):
        # A credentials write only succeeds over a bonded/encrypted link, so by now
        # pairing is done — clear the on-screen code regardless of payload validity.
        ui_state.clear_pairing()
        try:
            creds = json.loads(bytes(value).decode())
            with self._lock:
                self._pending = creds
            self._wake.set()
        except Exception as e:
            log.warning('Malformed credentials payload: %s', e)

    def _read_networks(self, options=None):
        # The phone reads Networks as its first operation after bonding completes,
        # so this is the moment to take the pairing code off the mirror screen.
        ui_state.clear_pairing()
        return self._read_blob('_net_read_buf', self._networks, options)

    def _read_status(self, options=None):
        return self._read_blob('_status_read_buf', self._status, options)

    def _read_blob(self, buf_attr, current, options):
        # bluezero hands us the ATT options dict (incl. 'offset') only because these
        # callbacks take exactly one parameter. Honor the Read Blob offset so a value
        # larger than one ATT packet (MTU-1) is read correctly instead of re-sending
        # from byte 0 on every blob (which corrupts the phone's JSON reassembly).
        offset = 0
        if options:
            try:
                offset = int(options.get('offset', 0))
            except (TypeError, ValueError):
                offset = 0
        if offset <= 0:                            # fresh read: pin the value being served
            setattr(self, buf_attr, current)
            return current
        return getattr(self, buf_attr)[offset:]    # blob continuation: serve the snapshot

    # _update_* methods are called from the provisioner thread.
    # GLib.idle_add queues the D-Bus notification onto the main loop thread.
    def _update_status(self, state: str, ip: str = '', api_base_url: str = '') -> None:
        ui_state.set_status(state)   # mirror the GATT status onto the UI state file
        obj: dict = {'state': state}
        if ip:
            obj['ip'] = ip
        if api_base_url:
            obj['apiBaseUrl'] = api_base_url
        self._status = _enc(obj)
        GLib.idle_add(self._notify_status)

    def _notify_status(self) -> bool:
        self._status_char.set_value(self._status)
        return GLib.SOURCE_REMOVE

    def _update_networks(self, nets: list) -> None:
        self._networks = _enc(nets)
        GLib.idle_add(self._notify_networks)

    def _notify_networks(self) -> bool:
        self._networks_char.set_value(self._networks)
        return GLib.SOURCE_REMOVE

    # Re-scan WiFi and push the fresh list to the phone. Runs on the provisioner
    # thread (nmcli can take a few seconds) — never on the GLib main thread.
    def _rescan(self) -> None:
        nets = _scan_networks()
        log.info('Found %d network(s)', len(nets))
        self._update_networks(nets)

    def _handle_credentials(self, creds: dict) -> bool:
        """Try to join the network. Returns True on success (loop should stop)."""
        ssid     = creds.get('ssid', '').strip()
        password = creds.get('password', '')
        if not ssid:
            log.warning('Empty SSID — ignoring')
            return False

        log.info('Connecting to "%s"…', ssid)
        self._update_status('connecting')

        ok, err = _connect_wifi(ssid, password)
        if ok:
            # nmcli returns the moment the link associates, but DHCP/routing can
            # take a few seconds to settle — poll briefly so we hand the phone a
            # real IP/apiBaseUrl instead of an empty one (the app needs the URL
            # to reach the backend and skip QR pairing).
            ip = ''
            for _ in range(15):
                ip = _get_lan_ip()
                if ip:
                    break
                time.sleep(1)
            api_url = f'http://{ip}:3000/api' if ip else ''
            log.info('Connected  IP=%s  apiBaseUrl=%s', ip, api_url)
            self._update_status('connected', ip=ip, api_base_url=api_url)
            # Allow the phone 3 s to read the final status before we exit.
            time.sleep(3)
            GLib.idle_add(self._quit_loop)
            return True

        log.warning('Connection failed: %s', err)
        self._update_status('failed')
        # Keep advertising so the user can correct the password and retry.
        return False

    # Runs in a background thread so the GLib loop (in main thread) stays responsive.
    def _provisioner_loop(self) -> None:
        # Keep the network list fresh so it is never empty when a phone connects.
        # At boot wlan0 may not be ready yet (the first scan returns nothing), so we
        # rescan on a timer until it is — and to reflect networks coming/going.
        log.info('Scanning for networks…')
        self._update_status('scanning')
        self._rescan()
        self._update_status('idle')

        force_timeout = 900  # --force shouldn't advertise forever if abandoned (15 min)

        while True:
            try:
                if self._wake.wait(timeout=10):
                    # The phone wrote credentials.
                    self._wake.clear()
                    with self._lock:
                        creds = self._pending
                        self._pending = None
                    if creds and self._handle_credentials(creds):
                        return
                    continue

                # Periodic tick (no credentials this interval):
                if not self._force and _nm_is_online():
                    # The Pi connected on its own (e.g. a saved profile came up
                    # after boot) — nothing to provision; free the advert slot.
                    log.info('Pi is online — stopping BLE provisioning.')
                    GLib.idle_add(self._quit_loop)
                    return
                if self._force and (time.monotonic() - self._start) > force_timeout:
                    log.info('Re-provision window elapsed with no connection — exiting.')
                    GLib.idle_add(self._quit_loop)
                    return
                # Keep the list current and self-heal an empty boot-time scan.
                self._rescan()
            except Exception:
                log.exception('provisioner loop iteration failed; continuing')

    def _quit_loop(self) -> bool:
        self._p.mainloop.quit()
        return GLib.SOURCE_REMOVE

    def run(self) -> None:
        _remove_known_devices()
        # Register the numeric-comparison agent and make the adapter pairable so the
        # encrypted-characteristic bonding shows a 6-digit code the user can confirm.
        try:
            self._agent = _register_agent()
            self._p.dongle.pairable = True
            log.info('Pairing agent registered (DisplayYesNo / numeric comparison); adapter pairable.')
        except Exception as e:
            log.warning('Could not register pairing agent: %s', e)

        threading.Thread(
            target=self._provisioner_loop,
            name='provisioner',
            daemon=True,
        ).start()
        log.info('Starting BLE advertisement…')
        self._p.publish()   # Runs GLib mainloop — blocks until _quit_loop is called.


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description='Smart Mirror BLE WiFi provisioning')
    parser.add_argument(
        '--force', action='store_true',
        help='Advertise for provisioning even if the Pi is already online '
             '(used by the "Change WiFi" re-provision flow).')
    args = parser.parse_args()

    log.info('Waiting for NetworkManager…')
    if not _nm_wait(30):
        log.error('NetworkManager did not start — exiting')
        sys.exit(1)

    if not args.force:
        log.info('Waiting up to %ds for an existing network connection…', ONLINE_GRACE_SECS)
        if _wait_for_online(ONLINE_GRACE_SECS):
            log.info('Pi is online — BLE setup not needed.')
            sys.exit(0)
        log.info('Still offline after %ds — entering BLE setup mode.', ONLINE_GRACE_SECS)

    try:
        from bluezero import adapter as bz_adapter
    except ImportError:
        log.error('bluezero not installed.  Run: pip3 install bluezero')
        sys.exit(1)

    adapters = bz_adapter.list_adapters()
    if not adapters:
        log.error('No Bluetooth adapter found.  Is bluetoothd running?  Check rfkill.')
        sys.exit(1)

    if args.force:
        log.info('Starting in --force mode (re-provision while online allowed).')
    provisioner = _BleProvisioner(adapters[0], force=args.force)
    provisioner.run()
    log.info('Provisioning complete.')


if __name__ == '__main__':
    main()
