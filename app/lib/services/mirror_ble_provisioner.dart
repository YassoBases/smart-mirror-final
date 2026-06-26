import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

// Shared GATT UUIDs — must match provisioning/ble-setup.py on the Pi.
const _kServiceUuid     = '4fafc201-1fb5-459e-8fcc-c5c9c3319143';
const _kNetworksUuid    = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
const _kCredentialsUuid = 'a9b1c2d3-e4f5-6789-abcd-ef0123456789';
const _kStatusUuid      = 'c0d1e2f3-a4b5-6789-cdef-012345678901';

class BleNetwork {
  final String ssid;
  final bool secured;
  const BleNetwork({required this.ssid, required this.secured});

  static List<BleNetwork> fromJson(List<dynamic> list) => list
      .map((e) => BleNetwork(ssid: e['ssid'] as String, secured: e['secured'] as bool))
      .toList();
}

class BleStatus {
  final String state;  // idle | scanning | connecting | connected | failed
  final String ip;
  final String apiBaseUrl;

  const BleStatus({required this.state, this.ip = '', this.apiBaseUrl = ''});

  static BleStatus fromJson(Map<String, dynamic> m) => BleStatus(
        state:      m['state'] as String? ?? 'idle',
        ip:         m['ip'] as String? ?? '',
        apiBaseUrl: m['apiBaseUrl'] as String? ?? '',
      );

  bool get isConnected => state == 'connected';
  bool get isFailed    => state == 'failed';
}

/// Thrown when first-time BLE pairing (bonding) doesn't complete — e.g. the user
/// dismissed the system pairing dialog or it timed out.
class PairingException implements Exception {
  final String message;
  PairingException(this.message);
  @override
  String toString() => message;
}

class MirrorBleProvisioner {
  BluetoothDevice? _device;
  BluetoothCharacteristic? _networks;
  BluetoothCharacteristic? _credentials;
  BluetoothCharacteristic? _status;

  static final Guid _svcGuid  = Guid(_kServiceUuid);
  static final Guid _netGuid  = Guid(_kNetworksUuid);
  static final Guid _credGuid = Guid(_kCredentialsUuid);
  static final Guid _statGuid = Guid(_kStatusUuid);
  static const String _kNamePrefix = 'Smart Mirror';

  /// Scan for the Smart Mirror. Returns the first matching device.
  /// Throws [TimeoutException] if none found within [timeout].
  ///
  /// The mirror advertises its 128-bit service UUID and its name in *separate*
  /// packets (the UUID + a 17-char name overflow the 31-byte legacy advert, so
  /// BlueZ moves the name into the scan response). Filtering an Android scan on
  /// the 128-bit UUID across that split is unreliable and made the app miss the
  /// mirror entirely, so we scan unfiltered — with an Android name keyword as a
  /// cheap pre-filter — and match on the advertised name. The real provisioning
  /// service is still verified via discoverServices() once connected.
  Future<BluetoothDevice> scanForMirror({
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final completer = Completer<BluetoothDevice>();
    StreamSubscription? sub;

    await FlutterBluePlus.startScan(
      withKeywords: Platform.isAndroid ? const [_kNamePrefix] : const [],
      timeout: timeout,
    );

    sub = FlutterBluePlus.scanResults.listen((results) {
      for (final r in results) {
        final advName = r.advertisementData.advName;
        final name = advName.isNotEmpty ? advName : r.device.platformName;
        final isMirror =
            name.toLowerCase().startsWith(_kNamePrefix.toLowerCase()) ||
                r.advertisementData.serviceUuids.contains(_svcGuid);
        if (isMirror && !completer.isCompleted) {
          completer.complete(r.device);
          sub?.cancel();
          FlutterBluePlus.stopScan();
          break;
        }
      }
    });

    FlutterBluePlus.isScanning.where((s) => !s).first.then((_) {
      sub?.cancel();
      if (!completer.isCompleted) {
        completer.completeError(
          TimeoutException('No Smart Mirror found nearby.'),
        );
      }
    });

    return completer.future;
  }

  Future<void> stopScan() => FlutterBluePlus.stopScan();

  /// Connect to [device] and discover the provisioning service characteristics.
  ///
  /// First-time pairing is driven explicitly (Android): [onPairing] fires just
  /// before the system pairing dialog appears so the UI can show a "confirm the
  /// code" step, and we *await* the bond before returning so the caller never
  /// races an encrypted GATT op against the handshake (the original code-62 bug).
  Future<void> connectAndDiscover(
    BluetoothDevice device, {
    void Function()? onPairing,
  }) async {
    _device = device;
    await _connectWithRetry(device);

    // Larger MTU so the networks/status JSON isn't truncated to the 23-byte
    // default. iOS negotiates the MTU itself and rejects this call, so skip it.
    if (!Platform.isIOS) {
      try {
        await device.requestMtu(247);
      } catch (_) {/* non-fatal */}
    }

    final services = await device.discoverServices();
    final svc = services.firstWhere(
      (s) => s.serviceUuid == _svcGuid,
      orElse: () => throw StateError('Smart Mirror provisioning service not found.'),
    );
    _networks    = _charFor(svc, _netGuid);
    _credentials = _charFor(svc, _credGuid);
    _status      = _charFor(svc, _statGuid);

    // Drive first-time bonding as an explicit, awaited step (Android). The mirror
    // shows a 6-digit code and Android shows the same code (numeric comparison);
    // the user taps Pair. iOS bonds lazily (createBond is unsupported there) via
    // its own dialog on the first encrypted op.
    if (Platform.isAndroid) {
      await _ensureBonded(device, onPairing);
    }
  }

  // BLE connection establishment is famously flaky on Android — code 62
  // (CONNECTION_FAILED_ESTABLISHMENT, the user's original failure), 133 and friends
  // are usually transient. Retry a few times; if a stale bond is the cause, forget
  // it so a clean pairing can happen.
  Future<void> _connectWithRetry(BluetoothDevice device) async {
    if (device.isConnected) return;
    const maxAttempts = 3;
    for (var attempt = 1;; attempt++) {
      try {
        await device.connect(timeout: const Duration(seconds: 15));
        return;
      } catch (e) {
        if (Platform.isAndroid && _isConnEstablishFail(e) && await _isBonded(device)) {
          // The phone holds a bond the mirror no longer has — establishment fails.
          try {
            await device.removeBond();
          } catch (_) {/* best effort */}
        }
        if (attempt >= maxAttempts || !_isTransientConnError(e)) rethrow;
        await Future.delayed(Duration(milliseconds: 600 * attempt));
      }
    }
  }

  bool _isConnEstablishFail(Object e) =>
      e is FlutterBluePlusException && e.code == 62;

  bool _isTransientConnError(Object e) {
    if (e is FlutterBluePlusException) {
      // 62 establish-fail, 133 generic GATT, 8 timeout, 19 peer-disconnect, 22 LMP.
      return const {62, 133, 8, 19, 22, 147}.contains(e.code);
    }
    return e is TimeoutException;
  }

  /// Ensure the link is bonded, surfacing a guided pairing step via [onPairing].
  /// Throws [PairingException] if the user dismisses the dialog or it times out.
  Future<void> _ensureBonded(BluetoothDevice device, void Function()? onPairing) async {
    if (await _isBonded(device)) return;

    onPairing?.call();
    try {
      await device.createBond(timeout: 60);
    } catch (e) {
      // createBond can throw even when the bond ultimately lands (e.g. an
      // "already bonded" race), so trust the real state before surfacing an error.
      if (e.toString().toLowerCase().contains('already') || await _isBonded(device)) {
        return;
      }
      throw PairingException(
        "Pairing wasn't completed — confirm the code matches and tap Pair on your "
        'phone, then try again.',
      );
    }
  }

  Future<bool> _isBonded(BluetoothDevice device) async {
    try {
      final s = await device.bondState.first.timeout(const Duration(seconds: 3));
      return s == BluetoothBondState.bonded;
    } catch (_) {
      return false;
    }
  }

  BluetoothCharacteristic _charFor(BluetoothService svc, Guid uuid) =>
      svc.characteristics.firstWhere(
        (c) => c.characteristicUuid == uuid,
        orElse: () => throw StateError('Characteristic $uuid not found.'),
      );

  /// Read the Networks characteristic and return parsed list.
  Future<List<BleNetwork>> readNetworks() async {
    final raw = await _networks!.read();
    final decoded = jsonDecode(utf8.decode(raw)) as List<dynamic>;
    return BleNetwork.fromJson(decoded);
  }

  /// Subscribe to Status notifications. Emits [BleStatus] on every change.
  Stream<BleStatus> statusStream() {
    return _status!.lastValueStream
        .where((v) => v.isNotEmpty)
        .map((v) => BleStatus.fromJson(jsonDecode(utf8.decode(v)) as Map<String, dynamic>));
  }

  Future<void> subscribeStatus() => _status!.setNotifyValue(true);

  /// Write WiFi credentials to the mirror.
  Future<void> submitCredentials({required String ssid, required String password}) async {
    final payload = jsonEncode({'ssid': ssid, 'password': password});
    await _credentials!.write(utf8.encode(payload), withoutResponse: false);
  }

  Future<void> disconnect() async {
    await _status?.setNotifyValue(false).catchError((_) => false);
    await _device?.disconnect();
    _device = null;
    _networks = _credentials = _status = null;
  }
}
