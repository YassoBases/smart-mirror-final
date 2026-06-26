import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:provider/provider.dart';
import '../config/api.dart';
import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import '../services/pending_pairing.dart';
import 'connection_settings_screen.dart';

/// Pairs the phone with the mirror.
///
/// Two modes selectable by the user:
///   • Camera mode  — scan the QR code displayed on the mirror screen
///   • Code mode    — type the 6-character short code shown below the QR
///
/// Returns a [String] mirrorId on success, or null if cancelled.
///
/// When [provisionUrlOnly] is true the screen runs a stripped-down flow used
/// during first-run setup (before any account exists): it only reads the
/// backend URL from the QR and persists it via [ApiConfig.setBaseUrl] — no
/// authenticated pairing. In that mode it pops `true` on success. This is what
/// breaks the bootstrap chicken-and-egg: the app must reach the backend to
/// register/login, but only learns its address from the QR.
class PairMirrorScreen extends StatefulWidget {
  final bool provisionUrlOnly;

  const PairMirrorScreen({super.key, this.provisionUrlOnly = false});

  @override
  State<PairMirrorScreen> createState() => _PairMirrorScreenState();
}

enum _PairMode { camera, code }

class _PairMirrorScreenState extends State<PairMirrorScreen> {
  _PairMode _mode = _PairMode.camera;
  final MobileScannerController _scanner = MobileScannerController();
  final TextEditingController _codeCtrl = TextEditingController();

  bool _processing = false;
  String? _error;
  bool _noServerAddress = false;

  @override
  void dispose() {
    _scanner.dispose();
    _codeCtrl.dispose();
    super.dispose();
  }

  // ── QR scan ─────────────────────────────────────────────────────────────────

  Future<void> _onDetect(BarcodeCapture capture) async {
    if (_processing) return;
    final raw = capture.barcodes.firstOrNull?.rawValue;
    if (raw == null) return;

    // Read api before any await to avoid BuildContext-across-async-gap lint
    final api = context.read<AuthProvider>().api;

    setState(() {
      _processing = true;
      _error = null;
      _noServerAddress = false;
    });
    await _scanner.stop();

    // Tracks whether the specific "no api field" case fired so the FormatException
    // handler can offer the manual-IP fallback rather than a dead end.
    bool missingApiField = false;

    try {
      final Map<String, dynamic> payload = jsonDecode(raw);

      // ── First-run provisioning: read the backend URL only, no pairing ──────
      // No account/JWT exists yet, so we can't (and don't) pair a profile here.
      // We just learn where the backend lives so onboarding can reach it.
      // Only `api` carries the HTTP API base; the sync QR's `backend` field is
      // a WebSocket URL and must NOT be used here.
      if (widget.provisionUrlOnly) {
        final url = payload['api'] as String?;
        if (url == null || url.isEmpty) {
          missingApiField = true;
          throw const FormatException(
              'This QR has no server address. Make sure the mirror is showing its pairing screen, then try again.');
        }
        await ApiConfig.setBaseUrl(url);
        // Stash pairing data from sync QR so sign-up can auto-pair without a
        // second scan. Only sync QRs (v:1) carry sid + code.
        final sid  = payload['sid']  as String?;
        final code = payload['code'] as String?;
        if (payload['v'] == 1 && sid != null && code != null) {
          PendingPairing.set(sid, code);
        }
        if (!mounted) return;
        Navigator.of(context).pop(true);
        return;
      }

      // ── Settings-page QR: { type: "smart-mirror-pair", mirrorId, api?, v } ──
      if (payload['type'] == 'smart-mirror-pair') {
        final mirrorId = payload['mirrorId'] as String?;
        if (mirrorId == null) {
          throw const FormatException('QR code is missing mirrorId field.');
        }
        // v2 QR also carries the backend URL. Provision it before popping so
        // the profile-link PATCH (and every later call) hits the right host —
        // works on home WiFi or a hotspot without a rebuild. Older v1 QRs omit
        // `api`, in which case we keep the current backend URL.
        final apiUrl = payload['api'] as String?;
        if (apiUrl != null && apiUrl.isNotEmpty) {
          await ApiConfig.setBaseUrl(apiUrl);
        }
        if (!mounted) return;
        Navigator.of(context).pop(mirrorId);
        return;
      }

      // ── Sync-module QR: { v:1, backend, api?, sid, mpk, nonce, code } ────
      if (payload['v'] != 1) {
        throw const FormatException('Unknown QR version — please update the app.');
      }

      // Newer mirrors advertise the LAN HTTP API in `api`. Adopt it before the
      // authenticated pair call so it works even if the app's default IP is
      // wrong for this network. (`backend` here is a WebSocket URL — not used.)
      final syncApiUrl = payload['api'] as String?;
      if (syncApiUrl != null && syncApiUrl.isNotEmpty) {
        await ApiConfig.setBaseUrl(syncApiUrl);
      }

      final sid       = payload['sid']  as String?;
      final shortCode = payload['code'] as String?;

      if (sid == null || shortCode == null) {
        throw const FormatException('QR code is missing required fields.');
      }

      final result   = await api.pairMirror(sid: sid, shortCode: shortCode);
      final mirrorId = result['mirrorId'] as String?;

      if (mirrorId == null) throw const FormatException('Backend returned no mirrorId.');

      if (!mounted) return;
      Navigator.of(context).pop(mirrorId);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() { _error = e.message; _processing = false; });
      await _scanner.start();
    } on FormatException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.message;
        _processing = false;
        _noServerAddress = widget.provisionUrlOnly && missingApiField;
      });
      await _scanner.start();
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Connection error — is the backend running?';
        _processing = false;
      });
      await _scanner.start();
    }
  }

  // Opens manual IP entry and propagates success back up the navigator stack.
  Future<void> _openManualEntry() async {
    final ok = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => const ConnectionSettingsScreen(popOnSave: true),
      ),
    );
    if (!mounted) return;
    if (ok == true) Navigator.of(context).pop(true);
  }

  // ── Short-code entry ─────────────────────────────────────────────────────────

  // UUID pattern: 8-4-4-4-12 hex chars with dashes
  static final _uuidRe = RegExp(
    r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  );

  Future<void> _submitCode() async {
    final raw = _codeCtrl.text.trim();
    if (raw.isEmpty) {
      setState(() => _error = 'Enter the code or Mirror ID shown on the mirror.');
      return;
    }

    // ── Full UUID (Settings page Mirror ID) — return directly ──────────────
    if (_uuidRe.hasMatch(raw)) {
      if (!mounted) return;
      Navigator.of(context).pop(raw.toLowerCase());
      return;
    }

    // ── Short pairing code (sync module) — call backend ────────────────────
    final code = raw.toUpperCase();
    if (code.length < 4) {
      setState(() => _error = 'Enter the code shown on the mirror.');
      return;
    }

    final api = context.read<AuthProvider>().api;

    setState(() { _processing = true; _error = null; });
    try {
      final result   = await api.pairByCode(shortCode: code);
      final mirrorId = result['mirrorId'] as String?;

      if (mirrorId == null) throw const FormatException('Backend returned no mirrorId.');

      if (!mounted) return;
      Navigator.of(context).pop(mirrorId);
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() { _error = e.message; _processing = false; });
    } on FormatException catch (e) {
      if (!mounted) return;
      setState(() { _error = e.message; _processing = false; });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _error = 'Connection error — is the backend running?';
        _processing = false;
      });
    }
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        iconTheme: const IconThemeData(color: Colors.white),
        title: Text(widget.provisionUrlOnly ? 'Connect to Mirror' : 'Pair Mirror',
            style: const TextStyle(
                color: Colors.white, fontWeight: FontWeight.bold)),
        elevation: 0,
        actions: [
          // Code entry triggers authenticated pairing, which is meaningless
          // before an account exists — hide the toggle in URL-only mode.
          if (!widget.provisionUrlOnly)
            TextButton(
              onPressed: () {
                setState(() {
                  _error = null;
                  _mode = _mode == _PairMode.camera
                      ? _PairMode.code
                      : _PairMode.camera;
                });
              },
              child: Text(
                _mode == _PairMode.camera ? 'Enter Code' : 'Scan QR',
                style: const TextStyle(color: Colors.white54, fontSize: 13),
              ),
            ),
        ],
      ),
      body: _mode == _PairMode.camera ? _buildCamera() : _buildCodeEntry(),
    );
  }

  // ── Camera mode ──────────────────────────────────────────────────────────────

  Widget _buildCamera() {
    return Stack(
      children: [
        MobileScanner(
          controller: _scanner,
          onDetect: _onDetect,
        ),
        IgnorePointer(
          child: CustomPaint(size: Size.infinite, painter: _ScanOverlayPainter()),
        ),
        Positioned(
          left: 0, right: 0, bottom: 60,
          child: Column(
            children: [
              if (_processing)
                const CircularProgressIndicator(color: Colors.white)
              else if (_error != null) ...[
                Container(
                  margin: const EdgeInsets.symmetric(horizontal: 32),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: Colors.red.withValues(alpha: 0.85),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(_error!,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Colors.white, fontSize: 14)),
                ),
                const SizedBox(height: 12),
                const Text('Point your camera at the QR code on the mirror',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white70, fontSize: 13)),
                if (_noServerAddress) ...[
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: _openManualEntry,
                    child: const Text('Enter IP manually instead',
                        style: TextStyle(
                            color: Colors.white70,
                            fontSize: 13,
                            decoration: TextDecoration.underline,
                            decorationColor: Colors.white70)),
                  ),
                ],
              ] else
                const Text('Point your camera at the QR code on the mirror',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white70, fontSize: 13)),
            ],
          ),
        ),
      ],
    );
  }

  // ── Code-entry mode ──────────────────────────────────────────────────────────

  Widget _buildCodeEntry() {
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 24),
          const Icon(Icons.tv_outlined, color: Colors.white54, size: 56),
          const SizedBox(height: 24),
          const Text(
            'Enter the pairing code',
            textAlign: TextAlign.center,
            style: TextStyle(
                color: Colors.white, fontSize: 22, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          const Text(
            'Enter the short code shown below the QR code,\nor paste the Mirror ID from Settings.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white54, fontSize: 14),
          ),
          const SizedBox(height: 32),
          TextField(
            controller: _codeCtrl,
            autofocus: true,
            textCapitalization: TextCapitalization.characters,
            inputFormatters: [
              TextInputFormatter.withFunction(
                  (oldV, newV) => newV.copyWith(text: newV.text.toUpperCase())),
            ],
            textAlign: TextAlign.center,
            maxLength: 36,
            style: const TextStyle(
                color: Colors.white,
                fontSize: 20,
                fontWeight: FontWeight.w300,
                letterSpacing: 4),
            decoration: const InputDecoration(
              hintText: 'A7K92Q  or  xxxxxxxx-xxxx-…',
              hintStyle: TextStyle(color: Colors.white24, letterSpacing: 2, fontSize: 14),
              counterText: '',
              enabledBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: Colors.white24)),
              focusedBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: Colors.white)),
            ),
            onSubmitted: (_) => _processing ? null : _submitCode(),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
          ],
          const SizedBox(height: 24),
          SizedBox(
            height: 50,
            child: ElevatedButton(
              onPressed: _processing ? null : _submitCode,
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              child: _processing
                  ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.black))
                  : const Text('Pair Mirror',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
            ),
          ),
        ],
      ),
    );
  }
}

class _ScanOverlayPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    const side  = 260.0;
    final cx    = size.width  / 2;
    final cy    = size.height / 2 - 40;
    final rect  = Rect.fromCenter(center: Offset(cx, cy), width: side, height: side);
    final rRect = RRect.fromRectAndRadius(rect, const Radius.circular(16));

    final overlay = Paint()..color = Colors.black.withValues(alpha: 0.55);
    final path = Path()
      ..addRect(Rect.fromLTWH(0, 0, size.width, size.height))
      ..addRRect(rRect)
      ..fillType = PathFillType.evenOdd;
    canvas.drawPath(path, overlay);

    final border = Paint()
      ..color       = Colors.white.withValues(alpha: 0.7)
      ..style       = PaintingStyle.stroke
      ..strokeWidth = 2;
    canvas.drawRRect(rRect, border);
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
