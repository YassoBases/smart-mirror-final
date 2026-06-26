import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';
import 'package:permission_handler/permission_handler.dart';
import '../connect_mirror_screen.dart';
import '../welcome_screen.dart';
import '../../config/api.dart';
import '../../services/mirror_ble_provisioner.dart';

enum _Step {
  intro,
  requestingPermission,
  scanning,
  connecting,
  pairing,
  pickNetwork,
  enterPassword,
  submitting,
  joining,
  done,
  error,
}

class BleSetupScreen extends StatefulWidget {
  const BleSetupScreen({super.key});

  @override
  State<BleSetupScreen> createState() => _BleSetupScreenState();
}

class _BleSetupScreenState extends State<BleSetupScreen> {
  final _provisioner = MirrorBleProvisioner();

  _Step _step = _Step.intro;
  String? _error;

  BluetoothDevice? _device;
  List<BleNetwork> _networks = [];
  BleNetwork? _selected;

  final _pwCtrl = TextEditingController();
  bool _showPassword = false;

  StreamSubscription<BleStatus>? _statusSub;
  Timer? _joinWatchdog;

  @override
  void dispose() {
    _pwCtrl.dispose();
    _manualSsidCtrl.dispose();
    _joinWatchdog?.cancel();
    _statusSub?.cancel();
    _provisioner.disconnect();
    super.dispose();
  }

  // ── navigation helpers ────────────────────────────────────────────────────

  void _skipToMirrorConnect() {
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const ConnectMirrorScreen()),
    );
  }

  void _goToWelcome() {
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const WelcomeScreen()),
    );
  }

  // ── BLE flow ──────────────────────────────────────────────────────────────

  Future<void> _start() async {
    setState(() {
      _step = _Step.requestingPermission;
      _error = null;
    });

    final granted = await _requestBlePermissions();
    if (!mounted) return;
    if (!granted) {
      setState(() {
        _step = _Step.error;
        _error = 'Bluetooth permission is required to set up the mirror. '
            'Please grant it in your device settings and try again.';
      });
      return;
    }

    await _scan();
  }

  Future<bool> _requestBlePermissions() async {
    // Android 12+ needs BLUETOOTH_SCAN + BLUETOOTH_CONNECT; ≤30 needs location.
    // iOS needs Bluetooth (handled via Info.plist description).
    final statuses = await [
      Permission.bluetoothScan,
      Permission.bluetoothConnect,
      Permission.locationWhenInUse,
    ].request();

    final scanOk    = statuses[Permission.bluetoothScan]    != PermissionStatus.denied;
    final connectOk = statuses[Permission.bluetoothConnect] != PermissionStatus.denied;
    return scanOk && connectOk;
  }

  Future<void> _scan() async {
    setState(() {
      _step = _Step.scanning;
      _error = null;
    });
    try {
      final device = await _provisioner.scanForMirror();
      if (!mounted) return;
      _device = device;
      await _connect();
    } on TimeoutException {
      if (!mounted) return;
      setState(() {
        _step = _Step.error;
        _error = "Couldn't find a Smart Mirror nearby.\n\n"
            'Make sure the mirror is powered on and in WiFi setup mode, '
            'then try again.';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _step = _Step.error;
        _error = 'Scan failed: ${e.toString().split('\n').first}';
      });
    }
  }

  Future<void> _connect() async {
    setState(() {
      _step = _Step.connecting;
      _error = null;
    });
    try {
      await _provisioner.connectAndDiscover(
        _device!,
        onPairing: () {
          if (mounted) setState(() => _step = _Step.pairing);
        },
      );
      if (!mounted) return;
      final nets = await _provisioner.readNetworks();
      if (!mounted) return;
      setState(() {
        _networks = nets;
        _step = _Step.pickNetwork;
      });
      await _provisioner.subscribeStatus();
    } on PairingException catch (e) {
      if (!mounted) return;
      setState(() {
        _step = _Step.error;
        _error = "Couldn't pair with your mirror.\n\n${e.message}";
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _step = _Step.error;
        _error = 'Failed to connect to mirror: ${e.toString().split('\n').first}';
      });
    }
  }

  void _pickNetwork(BleNetwork net) {
    _pwCtrl.clear();
    setState(() {
      _selected = net;
      _showPassword = false;
      _error = null;
      _step = net.secured ? _Step.enterPassword : _Step.submitting;
    });
    if (!net.secured) _submit('');
  }

  void _pickManual() {
    _pwCtrl.clear();
    setState(() {
      _selected = null;
      _showPassword = false;
      _error = null;
      _step = _Step.enterPassword;
    });
  }

  Future<void> _submit(String password) async {
    final ssid = _selected?.ssid ?? '';
    if (ssid.isEmpty && _step != _Step.enterPassword) return;

    // If manual entry, SSID comes from a separate controller we'll re-use
    // the password field for now and get the SSID from _manualSsidCtrl below.
    final actualSsid = _selected == null ? _manualSsidCtrl.text.trim() : ssid;
    if (actualSsid.isEmpty) {
      setState(() => _error = 'Please enter a network name.');
      return;
    }

    setState(() {
      _step = _Step.submitting;
      _error = null;
    });

    try {
      _statusSub?.cancel();
      _statusSub = _provisioner.statusStream().listen(_onStatus);
      // Timeout the write so a stalled bonding/handshake surfaces as an error
      // instead of an endless "Sending to mirror…" spinner.
      await _provisioner
          .submitCredentials(ssid: actualSsid, password: password)
          .timeout(const Duration(seconds: 15));
      if (!mounted) return;
      setState(() => _step = _Step.joining);
      _startJoinWatchdog();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _step = _Step.error;
        _error = 'Failed to send credentials: ${e.toString().split('\n').first}';
      });
    }
  }

  void _onStatus(BleStatus s) {
    if (!mounted) return;
    if (s.isConnected) {
      _joinWatchdog?.cancel();
      _statusSub?.cancel();
      _provisioner.disconnect();
      if (s.apiBaseUrl.isNotEmpty) {
        ApiConfig.setBaseUrl(s.apiBaseUrl);
        setState(() => _step = _Step.done);
        Future.delayed(const Duration(seconds: 2), () {
          if (mounted) _goToWelcome();
        });
      } else {
        setState(() => _step = _Step.done);
        Future.delayed(const Duration(seconds: 2), () {
          if (mounted) _skipToMirrorConnect();
        });
      }
    } else if (s.isFailed) {
      _joinWatchdog?.cancel();
      setState(() {
        _step = _Step.error;
        _error = 'The mirror couldn\'t connect to that network. '
            'Check the password and try again.';
      });
    }
  }

  void _startJoinWatchdog() {
    _joinWatchdog?.cancel();
    // The mirror normally reports back within ~20s (nmcli connect + a 3s grace).
    // If we hear nothing by 35s, stop waiting and let the user retry rather than
    // spinning on "joining" forever.
    _joinWatchdog = Timer(const Duration(seconds: 35), () {
      if (!mounted || _step != _Step.joining) return;
      _statusSub?.cancel();
      setState(() {
        _step = _Step.error;
        _error = "The mirror didn't report back in time. It may still be "
            'connecting — check your WiFi password and try again.';
      });
    });
  }

  final _manualSsidCtrl = TextEditingController();

  // ── build ─────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: switch (_step) {
          _Step.intro                => _buildIntro(),
          _Step.requestingPermission => _buildSpinner('Requesting Bluetooth permission…'),
          _Step.scanning             => _buildSpinner('Looking for your mirror…'),
          _Step.connecting           => _buildSpinner('Connecting to mirror…'),
          _Step.pairing              => _buildPairing(),
          _Step.pickNetwork          => _buildNetworkPicker(),
          _Step.enterPassword        => _buildPasswordEntry(),
          _Step.submitting           => _buildSpinner('Sending to mirror…'),
          _Step.joining              => _buildJoining(),
          _Step.done                 => _buildDone(),
          _Step.error                => _buildError(),
        },
      ),
    );
  }

  // ── intro ─────────────────────────────────────────────────────────────────

  Widget _buildIntro() {
    return Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          const Spacer(),
          const Icon(Icons.bluetooth_searching, size: 56, color: Colors.white),
          const SizedBox(height: 24),
          const Text(
            'Connect mirror\nto WiFi',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Colors.white,
              fontSize: 36,
              fontWeight: FontWeight.bold,
              height: 1.2,
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            "Your mirror doesn't need to create a hotspot. "
            "The app sends your WiFi password directly over Bluetooth — "
            "your phone stays on its own network the whole time.",
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white54, fontSize: 15, height: 1.5),
          ),
          const SizedBox(height: 36),
          const _StepRow(
            number: '1',
            title: 'App finds the mirror',
            body: 'We scan nearby and connect to your mirror over Bluetooth.',
          ),
          const SizedBox(height: 20),
          const _StepRow(
            number: '2',
            title: 'Pick your WiFi',
            body: 'Choose your home WiFi or your phone\'s hotspot.',
          ),
          const SizedBox(height: 20),
          const _StepRow(
            number: '3',
            title: 'Mirror connects',
            body: 'The mirror joins the network and you\'re ready to go.',
          ),
          const Spacer(),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton(
              onPressed: _start,
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              child: const Text(
                'Find my mirror',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
              ),
            ),
          ),
          const SizedBox(height: 8),
          TextButton(
            onPressed: _skipToMirrorConnect,
            child: const Text(
              'My mirror is already online — skip',
              style: TextStyle(color: Colors.white38, fontSize: 14),
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  // ── spinner ───────────────────────────────────────────────────────────────

  Widget _buildSpinner(String label) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(color: Colors.white),
          const SizedBox(height: 20),
          Text(label,
              style: const TextStyle(color: Colors.white70, fontSize: 16)),
        ],
      ),
    );
  }

  // ── pairing (first-time bond; mirror shows the 6-digit code) ───────────────

  Widget _buildPairing() {
    return Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          const Spacer(),
          const Icon(Icons.phonelink_lock, size: 56, color: Colors.white),
          const SizedBox(height: 24),
          const Text(
            'Pair with your mirror',
            textAlign: TextAlign.center,
            style: TextStyle(
                color: Colors.white, fontSize: 28, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 16),
          const Text(
            'Your mirror is showing a 6-digit code. On your phone, check the code '
            'matches and tap "Pair" to continue.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white54, fontSize: 15, height: 1.5),
          ),
          const SizedBox(height: 40),
          const CircularProgressIndicator(color: Colors.white),
          const SizedBox(height: 20),
          const Text(
            'Waiting for you to confirm…',
            style: TextStyle(color: Colors.white38, fontSize: 13),
          ),
          const Spacer(),
        ],
      ),
    );
  }

  // ── joining (with live status) ────────────────────────────────────────────

  Widget _buildJoining() {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const CircularProgressIndicator(color: Colors.white),
          const SizedBox(height: 20),
          Text(
            'Mirror is joining ${_selected?.ssid ?? 'the network'}…',
            style: const TextStyle(color: Colors.white70, fontSize: 16),
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 8),
          const Text(
            'This can take up to 20 seconds.',
            style: TextStyle(color: Colors.white38, fontSize: 13),
          ),
        ],
      ),
    );
  }

  // ── network picker ────────────────────────────────────────────────────────

  Widget _buildNetworkPicker() {
    return Column(
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(28, 28, 28, 0),
          child: Text(
            'Pick your WiFi',
            style: TextStyle(
                color: Colors.white, fontSize: 22, fontWeight: FontWeight.bold),
          ),
        ),
        const SizedBox(height: 8),
        Expanded(
          child: _networks.isEmpty
              ? Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Text('No networks found.',
                          style: TextStyle(color: Colors.white54, fontSize: 15)),
                      const SizedBox(height: 12),
                      TextButton(
                        onPressed: _connect,
                        child: const Text('Refresh',
                            style: TextStyle(color: Colors.white70)),
                      ),
                    ],
                  ),
                )
              : ListView(
                  children: [
                    ..._networks.map((n) => ListTile(
                          leading: Icon(
                            n.secured ? Icons.lock : Icons.lock_open,
                            color: Colors.white70,
                            size: 20,
                          ),
                          title: Text(n.ssid,
                              style: const TextStyle(
                                  color: Colors.white, fontSize: 15)),
                          trailing: const Icon(Icons.chevron_right,
                              color: Colors.white38),
                          onTap: () => _pickNetwork(n),
                        )),
                    ListTile(
                      leading: const Icon(Icons.edit, color: Colors.white38, size: 20),
                      title: const Text('Enter network manually',
                          style: TextStyle(color: Colors.white54, fontSize: 15)),
                      trailing: const Icon(Icons.chevron_right,
                          color: Colors.white38),
                      onTap: _pickManual,
                    ),
                  ],
                ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(28, 4, 28, 24),
          child: TextButton(
            onPressed: _skipToMirrorConnect,
            child: const Text(
              'My mirror is already on WiFi — skip',
              style: TextStyle(color: Colors.white38, fontSize: 14),
            ),
          ),
        ),
      ],
    );
  }

  // ── password entry ────────────────────────────────────────────────────────

  Widget _buildPasswordEntry() {
    final isManual = _selected == null;
    return Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Spacer(),
          const Icon(Icons.wifi_password, size: 40, color: Colors.white),
          const SizedBox(height: 20),
          if (isManual) ...[
            const Text('Enter network details',
                style: TextStyle(
                    color: Colors.white,
                    fontSize: 24,
                    fontWeight: FontWeight.bold)),
            const SizedBox(height: 20),
            TextField(
              controller: _manualSsidCtrl,
              autofocus: true,
              style: const TextStyle(color: Colors.white),
              decoration: _inputDecoration('Network name (SSID)'),
              textInputAction: TextInputAction.next,
            ),
            const SizedBox(height: 12),
          ] else ...[
            Text(_selected!.ssid,
                style: const TextStyle(
                    color: Colors.white,
                    fontSize: 24,
                    fontWeight: FontWeight.bold)),
          ],
          const SizedBox(height: 8),
          Text(
            isManual
                ? 'Enter the name and password of the network to join.'
                : 'Enter the password for this network.',
            style: const TextStyle(color: Colors.white54, fontSize: 14),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _pwCtrl,
            obscureText: !_showPassword,
            autofocus: !isManual,
            style: const TextStyle(color: Colors.white),
            decoration: _inputDecoration('Password').copyWith(
              suffixIcon: IconButton(
                icon: Icon(
                  _showPassword ? Icons.visibility_off : Icons.visibility,
                  color: Colors.white38,
                ),
                onPressed: () =>
                    setState(() => _showPassword = !_showPassword),
              ),
            ),
            onSubmitted: (pw) => _submit(pw),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!,
                style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
          ],
          const Spacer(),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton(
              onPressed: () => _submit(_pwCtrl.text),
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              child: const Text('Connect',
                  style:
                      TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
            ),
          ),
          const SizedBox(height: 10),
          SizedBox(
            width: double.infinity,
            child: TextButton(
              onPressed: () => setState(() {
                _step = _Step.pickNetwork;
                _error = null;
              }),
              child: const Text(
                '← Back to network list',
                style: TextStyle(color: Colors.white54, fontSize: 14),
              ),
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }

  InputDecoration _inputDecoration(String hint) => InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: Colors.white24),
        filled: true,
        fillColor: Colors.white10,
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: Colors.white12),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: Colors.white38),
        ),
      );

  // ── done ──────────────────────────────────────────────────────────────────

  Widget _buildDone() {
    return Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          const Spacer(),
          const Icon(Icons.check_circle_outline, size: 64, color: Colors.white),
          const SizedBox(height: 24),
          Text(
            'Mirror connected\nto ${_selected?.ssid ?? 'your network'}',
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: Colors.white,
              fontSize: 28,
              fontWeight: FontWeight.bold,
              height: 1.3,
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            "All set — you'll be taken to the app in a moment.",
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white54, fontSize: 15),
          ),
          const Spacer(),
          const CircularProgressIndicator(color: Colors.white54, strokeWidth: 2),
          const SizedBox(height: 48),
        ],
      ),
    );
  }

  // ── error ─────────────────────────────────────────────────────────────────

  Widget _buildError() {
    final canRetry = _error?.contains('password') == true ||
        _error?.contains('credentials') == true;
    return Padding(
      padding: const EdgeInsets.all(28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          const Spacer(),
          const Icon(Icons.bluetooth_disabled, size: 56, color: Colors.white54),
          const SizedBox(height: 24),
          Text(
            // The scan-timeout error is the only one that starts with "Couldn't
            // find" — show a discovery-specific heading for it so "Couldn't
            // connect" stays reserved for genuine connect/bond failures.
            (_error?.startsWith("Couldn't find") ?? false)
                ? "Couldn't find the mirror"
                : (_error?.startsWith("Couldn't pair") ?? false)
                    ? "Couldn't pair"
                    : "Couldn't connect",
            style: const TextStyle(
                color: Colors.white, fontSize: 26, fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 12),
          Text(
            _error ?? 'Something went wrong.',
            textAlign: TextAlign.center,
            style: const TextStyle(
                color: Colors.white54, fontSize: 14, height: 1.5),
          ),
          const Spacer(),
          SizedBox(
            width: double.infinity,
            height: 52,
            child: ElevatedButton(
              onPressed: () {
                if (canRetry && _selected != null) {
                  setState(() {
                    _step = _Step.enterPassword;
                    _error = null;
                    _pwCtrl.clear();
                  });
                } else {
                  setState(() {
                    _step = _Step.intro;
                    _error = null;
                  });
                  _provisioner.disconnect();
                }
              },
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              child: Text(
                canRetry ? 'Try a different password' : 'Try again',
                style:
                    const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
              ),
            ),
          ),
          const SizedBox(height: 8),
          TextButton(
            onPressed: _skipToMirrorConnect,
            child: const Text(
              'My mirror is already online — skip',
              style: TextStyle(color: Colors.white38, fontSize: 14),
            ),
          ),
          const SizedBox(height: 24),
        ],
      ),
    );
  }
}

class _StepRow extends StatelessWidget {
  final String number;
  final String title;
  final String body;

  const _StepRow({required this.number, required this.title, required this.body});

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 28,
          height: 28,
          decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle),
          child: Center(
            child: Text(number,
                style: const TextStyle(
                    color: Colors.black,
                    fontSize: 13,
                    fontWeight: FontWeight.bold)),
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title,
                  style: const TextStyle(
                      color: Colors.white,
                      fontSize: 15,
                      fontWeight: FontWeight.w600)),
              const SizedBox(height: 4),
              Text(body,
                  style: const TextStyle(
                      color: Colors.white54, fontSize: 13, height: 1.4)),
            ],
          ),
        ),
      ],
    );
  }
}
