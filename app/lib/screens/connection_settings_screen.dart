import 'dart:async';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:provider/provider.dart';
import '../config/api.dart';
import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import '../services/connectivity_service.dart';
import 'onboarding/ble_setup_screen.dart';

/// Manual fallback for setting the backend (mirror/server) address when the
/// QR pairing flow isn't available — e.g. no camera, or a mirror running an
/// older build whose QR predates the v2 (URL-carrying) payload.
///
/// Lets the user type an address, test it against `GET /health`, and save it.
/// Saving persists via [ApiConfig.setBaseUrl] so it survives restarts.
///
/// When [popOnSave] is true the screen pops `true` after a successful save
/// instead of showing a snackbar — used as the manual fallback in the first-run
/// connection gate, so the caller can advance to sign-up / sign-in.
class ConnectionSettingsScreen extends StatefulWidget {
  final bool popOnSave;

  const ConnectionSettingsScreen({super.key, this.popOnSave = false});

  @override
  State<ConnectionSettingsScreen> createState() =>
      _ConnectionSettingsScreenState();
}

class _ConnectionSettingsScreenState extends State<ConnectionSettingsScreen> {
  late final TextEditingController _urlCtrl;

  bool _testing = false;
  bool _saving = false;
  bool _reprovisioning = false;
  String? _error;
  String? _success;

  @override
  void initState() {
    super.initState();
    _urlCtrl = TextEditingController(text: ApiConfig.hostFromBaseUrl());
  }

  @override
  void dispose() {
    _urlCtrl.dispose();
    super.dispose();
  }

  Future<void> _test() async {
    final raw = _urlCtrl.text.trim();
    if (raw.isEmpty) {
      setState(() {
        _error = 'Enter the mirror / server address first.';
        _success = null;
      });
      return;
    }

    final base = ApiConfig.normalize(raw);
    setState(() {
      _testing = true;
      _error = null;
      _success = null;
    });

    try {
      final res = await http
          .get(Uri.parse(ConnectivityService.healthUrl(base)))
          .timeout(const Duration(seconds: 5));
      if (!mounted) return;
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setState(() => _success = 'Connected — backend is reachable.');
      } else {
        setState(() => _error =
            'Server responded with HTTP ${res.statusCode}. Check the address.');
      }
    } on TimeoutException {
      if (mounted) {
        setState(() => _error =
            'Timed out. Check the IP and that phone + server share a network.');
      }
    } catch (_) {
      if (mounted) {
        setState(() => _error =
            'Connection error — is the backend running and reachable?');
      }
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  Future<void> _save() async {
    final raw = _urlCtrl.text.trim();
    if (raw.isEmpty) {
      setState(() {
        _error = 'Enter the mirror / server address first.';
        _success = null;
      });
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
      _success = null;
    });

    await ApiConfig.setBaseUrl(raw);
    if (!mounted) return;
    // First-run gate: hand control back so the caller can proceed to login.
    if (widget.popOnSave) {
      Navigator.of(context).pop(true);
      return;
    }
    // Reflect the host back into the field (scheme/port hidden from user).
    _urlCtrl.text = ApiConfig.hostFromBaseUrl();
    setState(() => _saving = false);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Server address saved'),
        backgroundColor: Colors.green,
        duration: Duration(seconds: 2),
      ),
    );
  }

  // Puts the mirror into BLE setup mode, then opens the BLE flow to pick the new
  // network. Needs the phone to currently reach the mirror's backend.
  Future<void> _changeWifi() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF1A1A1A),
        title: const Text('Change mirror WiFi',
            style: TextStyle(color: Colors.white)),
        content: const Text(
          'This puts the mirror into Bluetooth setup mode so you can move it to a '
          'different network. Keep your phone nearby. Continue?',
          style: TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel', style: TextStyle(color: Colors.white54)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Continue', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    final api = context.read<AuthProvider>().api;
    final navigator = Navigator.of(context);
    setState(() {
      _reprovisioning = true;
      _error = null;
      _success = null;
    });

    try {
      // Best-effort: an online mirror starts advertising in response to this POST.
      // An offline mirror can't be reached, so cap the wait and fall through to the
      // Bluetooth flow — BLE setup needs no network and is exactly this recovery
      // path (router off, SSID changed, password rotated).
      await api.reprovisionMirror().timeout(const Duration(seconds: 6));
    } on ApiException catch (e) {
      // The mirror answered over HTTP but refused the request (e.g. auth, or the
      // trigger is missing) — a genuine error, so surface it and stop here.
      if (mounted) {
        setState(() {
          _reprovisioning = false;
          _error = "Couldn't start setup mode: ${e.message}";
        });
      }
      return;
    } catch (_) {
      // Transport error / timeout means the mirror is offline — the very situation
      // BLE setup exists for. Don't dead-end; proceed to the Bluetooth flow, whose
      // scan shows an accurate "couldn't find a mirror" message if none is found.
    }

    if (!mounted) return;
    setState(() => _reprovisioning = false);
    navigator.push(
      MaterialPageRoute(builder: (_) => const BleSetupScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        iconTheme: const IconThemeData(color: Colors.white),
        title: const Text('Connection',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        elevation: 0,
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.black,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'MIRROR IP ADDRESS',
                  style: TextStyle(
                      color: Colors.white70,
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      letterSpacing: 0.5),
                ),
                const SizedBox(height: 8),
                TextField(
                  controller: _urlCtrl,
                  autocorrect: false,
                  keyboardType: TextInputType.text,
                  style: const TextStyle(
                      color: Colors.white, fontFamily: 'monospace'),
                  decoration: InputDecoration(
                    hintText: '192.168.1.6',
                    hintStyle: const TextStyle(color: Colors.white24),
                    filled: true,
                    fillColor: Colors.transparent,
                    contentPadding: const EdgeInsets.symmetric(
                        horizontal: 14, vertical: 12),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                      borderSide: const BorderSide(color: Colors.white12),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                      borderSide: const BorderSide(color: Colors.white38),
                    ),
                  ),
                ),
                const SizedBox(height: 6),
                const Text(
                  "Enter your mirror's IP address (shown on the mirror); "
                  'the app adds the port and path automatically.',
                  style: TextStyle(color: Colors.white24, fontSize: 11),
                ),
              ],
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 16),
            Text(_error!, style: const TextStyle(color: Colors.redAccent)),
          ],
          if (_success != null) ...[
            const SizedBox(height: 16),
            Text(_success!, style: const TextStyle(color: Colors.greenAccent)),
          ],
          const SizedBox(height: 24),
          SizedBox(
            height: 50,
            child: OutlinedButton(
              onPressed: _testing ? null : _test,
              style: OutlinedButton.styleFrom(
                side: const BorderSide(color: Colors.white38),
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              child: _testing
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.white))
                  : const Text('Test connection',
                      style: TextStyle(
                          color: Colors.white,
                          fontSize: 16,
                          fontWeight: FontWeight.w600)),
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 50,
            child: ElevatedButton(
              onPressed: _saving ? null : _save,
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              child: _saving
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.black))
                  : const Text('Save',
                      style: TextStyle(
                          fontWeight: FontWeight.w600, fontSize: 16)),
            ),
          ),
          if (!widget.popOnSave) ...[
            const SizedBox(height: 28),
            const Divider(color: Colors.white12),
            const SizedBox(height: 16),
            const Text(
              'CHANGE MIRROR WIFI',
              style: TextStyle(
                  color: Colors.white70,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.5),
            ),
            const SizedBox(height: 8),
            const Text(
              'Moving to a new router or password? Put the mirror back into '
              'Bluetooth setup mode and pick the new network.',
              style: TextStyle(color: Colors.white24, fontSize: 11),
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: 50,
              child: OutlinedButton.icon(
                onPressed: _reprovisioning ? null : _changeWifi,
                icon: _reprovisioning
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                            strokeWidth: 2, color: Colors.white))
                    : const Icon(Icons.bluetooth_searching,
                        color: Colors.white, size: 20),
                label: const Text('Set up a different WiFi',
                    style: TextStyle(
                        color: Colors.white,
                        fontSize: 16,
                        fontWeight: FontWeight.w600)),
                style: OutlinedButton.styleFrom(
                  side: const BorderSide(color: Colors.white38),
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
