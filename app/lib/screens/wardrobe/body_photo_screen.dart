import 'dart:io';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/connection_error_view.dart';

const _kBodyTips =
    'Stand 2–3 metres back against a plain wall. Fit your whole body in the '
    'frame. Neutral pose, arms slightly away from your sides.';
const _kBodyExplainerSeenKey = 'wardrobe_body_explainer_seen';

// Captures the single full-body photo per profile that the mirror reuses for
// every virtual try-on render. Reuses the face-setup camera lifecycle but with
// no ML Kit — capture → preview → use/retake. On open it loads any existing
// photo and lets the user replace it. Pops true if a photo was saved.
class BodyPhotoScreen extends StatefulWidget {
  final int profileId;
  const BodyPhotoScreen({super.key, required this.profileId});

  @override
  State<BodyPhotoScreen> createState() => _BodyPhotoScreenState();
}

class _BodyPhotoScreenState extends State<BodyPhotoScreen> {
  CameraController? _controller;
  bool _cameraReady = false;
  String? _cameraError;

  bool _loadingExisting = true;
  bool _existingConnectionError = false;
  String? _existingPhotoUrl; // currently stored photo, if any

  String? _capturedPath; // frozen still awaiting confirmation
  bool _uploading = false;
  String? _uploadError;
  bool _savedAny = false; // did this session store a photo

  // Whether we are actively capturing (camera shown) vs. reviewing the stored
  // photo. Starts in review mode if a photo already exists.
  bool _capturing = false;

  @override
  void initState() {
    super.initState();
    _loadExisting();
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  ApiService get _api => context.read<AuthProvider>().api;

  Future<void> _loadExisting() async {
    setState(() {
      _loadingExisting = true;
      _existingConnectionError = false;
    });
    try {
      final url = await _api.getBodyPhoto(widget.profileId);
      if (!mounted) return;
      setState(() {
        _existingPhotoUrl = url;
        _loadingExisting = false;
        _capturing = url == null; // no photo yet → go straight to capture
      });
      if (_capturing) {
        _initializeCamera();
        WidgetsBinding.instance
            .addPostFrameCallback((_) => _maybeShowExplainer());
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _uploadError = e.message;
          _loadingExisting = false;
          _capturing = true;
        });
        _initializeCamera();
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _existingConnectionError = true;
          _loadingExisting = false;
        });
      }
    }
  }

  Future<void> _maybeShowExplainer() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_kBodyExplainerSeenKey) == true) return;
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Colors.grey[900],
        title: const Text('Your body photo',
            style: TextStyle(color: Colors.white)),
        content: const Text(
          'This photo is used by the mirror to render suggested outfits on '
          'you. It is stored on your household\'s own backend. Stand back '
          'against a plain wall with your whole body in frame.',
          style: TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Got it', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );
    await prefs.setBool(_kBodyExplainerSeenKey, true);
  }

  Future<void> _initializeCamera() async {
    try {
      final cameras = await availableCameras();
      if (!mounted) return;
      if (cameras.isEmpty) {
        setState(() => _cameraError = 'No cameras found on device.');
        return;
      }
      final rear = cameras.firstWhere(
        (c) => c.lensDirection == CameraLensDirection.back,
        orElse: () => cameras.first,
      );
      _controller = CameraController(
        rear,
        ResolutionPreset.high,
        enableAudio: false,
      );
      await _controller!.initialize();
      if (!mounted) return;
      setState(() => _cameraReady = true);
    } catch (e) {
      if (mounted) setState(() => _cameraError = 'Camera error: $e');
    }
  }

  Future<void> _capture() async {
    final ctrl = _controller;
    if (ctrl == null || !ctrl.value.isInitialized || _uploading) return;
    try {
      final XFile photo = await ctrl.takePicture();
      if (mounted) setState(() => _capturedPath = photo.path);
    } catch (e) {
      if (mounted) setState(() => _cameraError = 'Capture failed: $e');
    }
  }

  void _retake() => setState(() => _capturedPath = null);

  Future<void> _usePhoto() async {
    final path = _capturedPath;
    if (path == null) return;
    setState(() {
      _uploading = true;
      _uploadError = null;
    });
    try {
      final url = await _api.uploadBodyPhoto(widget.profileId, path);
      if (!mounted) return;
      setState(() {
        _existingPhotoUrl = url.isEmpty ? _existingPhotoUrl : url;
        _capturedPath = null;
        _capturing = false;
        _savedAny = true;
      });
      // Release the camera now that we are back in review mode.
      _controller?.dispose();
      _controller = null;
      _cameraReady = false;
    } on ApiException catch (e) {
      if (mounted) setState(() => _uploadError = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _uploadError = 'Connection error — could not save photo');
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  void _startReplace() {
    setState(() {
      _capturing = true;
      _capturedPath = null;
      _uploadError = null;
    });
    _initializeCamera();
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeShowExplainer());
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // Return whether a photo was saved so the closet can refresh its indicator.
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) Navigator.of(context).pop(_savedAny);
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        appBar: AppBar(
          backgroundColor: Colors.black,
          elevation: 0,
          iconTheme: const IconThemeData(color: Colors.white),
          title: const Text('Body photo',
              style:
                  TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        ),
        body: SafeArea(child: _body()),
      ),
    );
  }

  Widget _body() {
    if (_loadingExisting) {
      return const Center(child: CircularProgressIndicator(color: Colors.white));
    }
    if (_existingConnectionError) {
      return ConnectionErrorView(onRetry: _loadExisting);
    }
    return _capturing ? _captureView() : _reviewView();
  }

  // ── Review (stored photo) ──────────────────────────────────────────────────

  Widget _reviewView() {
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          color: Colors.grey[900],
          child: const Text(
            'The mirror uses this photo to render outfits on you. '
            'It is stored on your household\'s own backend.',
            style: TextStyle(color: Colors.white70, fontSize: 13),
            textAlign: TextAlign.center,
          ),
        ),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: _existingPhotoUrl == null
                ? const Center(
                    child: Text('No body photo set yet.',
                        style: TextStyle(color: Colors.white54)),
                  )
                : ClipRRect(
                    borderRadius: BorderRadius.circular(16),
                    child: Image.network(
                      _existingPhotoUrl!,
                      fit: BoxFit.contain,
                      errorBuilder: (_, __, ___) => const Center(
                        child: Icon(Icons.broken_image,
                            color: Colors.white24, size: 48),
                      ),
                    ),
                  ),
          ),
        ),
        if (_uploadError != null)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: Text(_uploadError!,
                style: const TextStyle(color: Colors.redAccent),
                textAlign: TextAlign.center),
          ),
        Padding(
          padding: const EdgeInsets.all(20),
          child: SizedBox(
            width: double.infinity,
            height: 50,
            child: ElevatedButton.icon(
              onPressed: _startReplace,
              icon: const Icon(Icons.camera_alt),
              label: Text(
                  _existingPhotoUrl == null ? 'Take photo' : 'Replace photo'),
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
            ),
          ),
        ),
      ],
    );
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  Widget _captureView() {
    return Column(
      children: [
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(16),
          color: Colors.grey[900],
          child: const Text(
            _kBodyTips,
            style: TextStyle(color: Colors.white70, fontSize: 13),
            textAlign: TextAlign.center,
          ),
        ),
        Expanded(child: _preview()),
        _controls(),
      ],
    );
  }

  Widget _preview() {
    if (_cameraError != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_cameraError!,
                style: const TextStyle(color: Colors.redAccent),
                textAlign: TextAlign.center),
            const SizedBox(height: 12),
            ElevatedButton.icon(
              onPressed: () {
                setState(() {
                  _cameraError = null;
                  _cameraReady = false;
                });
                _initializeCamera();
              },
              icon: const Icon(Icons.refresh),
              label: const Text('Retry camera'),
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
              ),
            ),
          ],
        ),
      );
    }

    if (_capturedPath != null) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(16),
          child: Image.file(File(_capturedPath!), fit: BoxFit.contain),
        ),
      );
    }

    if (_controller == null || !_cameraReady) {
      return const Center(child: CircularProgressIndicator(color: Colors.white));
    }

    final preview = _controller!.value.previewSize;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: AspectRatio(
        aspectRatio: 3 / 4,
        child: Stack(
          fit: StackFit.expand,
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(16),
              child: preview == null
                  ? CameraPreview(_controller!)
                  : FittedBox(
                      fit: BoxFit.cover,
                      clipBehavior: Clip.hardEdge,
                      child: SizedBox(
                        width: preview.height,
                        height: preview.width,
                        child: CameraPreview(_controller!),
                      ),
                    ),
            ),
            const Positioned.fill(
              child: IgnorePointer(
                child: CustomPaint(painter: _BodyOutlinePainter()),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _controls() {
    if (_cameraError != null) return const SizedBox(height: 24);

    if (_capturedPath != null) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            if (_uploadError != null) ...[
              Text(_uploadError!,
                  style: const TextStyle(color: Colors.redAccent),
                  textAlign: TextAlign.center),
              const SizedBox(height: 12),
            ],
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _uploading ? null : _retake,
                    style: OutlinedButton.styleFrom(
                      side: const BorderSide(color: Colors.white54),
                      padding: const EdgeInsets.symmetric(vertical: 16),
                    ),
                    child: const Text('Retake',
                        style: TextStyle(color: Colors.white)),
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: ElevatedButton(
                    onPressed: _uploading ? null : _usePhoto,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.white,
                      foregroundColor: Colors.black,
                      padding: const EdgeInsets.symmetric(vertical: 16),
                    ),
                    child: _uploading
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                                strokeWidth: 2, color: Colors.black))
                        : const Text('Use photo',
                            style: TextStyle(fontWeight: FontWeight.w600)),
                  ),
                ),
              ],
            ),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.all(20),
      child: GestureDetector(
        onTap: _cameraReady ? _capture : null,
        child: Container(
          width: 72,
          height: 72,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Colors.white,
            border: Border.all(color: Colors.white54, width: 4),
          ),
          child: const Icon(Icons.camera_alt, color: Colors.black, size: 32),
        ),
      ),
    );
  }
}

// A simple full-body silhouette guide (head, torso, legs) for portrait framing.
class _BodyOutlinePainter extends CustomPainter {
  const _BodyOutlinePainter();

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.white54
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;

    final cx = size.width / 2;
    final headRadius = size.height * 0.06;
    final headCenter = Offset(cx, size.height * 0.14);

    // Head
    canvas.drawCircle(headCenter, headRadius, paint);

    // Body: shoulders down to feet as a tapered outline.
    final top = headCenter.dy + headRadius;
    final bottom = size.height * 0.94;
    final shoulderHalf = size.width * 0.20;
    final hipHalf = size.width * 0.14;
    final footHalf = size.width * 0.10;
    final midY = top + (bottom - top) * 0.45;

    final path = Path()
      ..moveTo(cx - shoulderHalf, top + (bottom - top) * 0.08)
      ..lineTo(cx - hipHalf, midY)
      ..lineTo(cx - footHalf, bottom)
      ..lineTo(cx + footHalf, bottom)
      ..lineTo(cx + hipHalf, midY)
      ..lineTo(cx + shoulderHalf, top + (bottom - top) * 0.08)
      ..close();
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_BodyOutlinePainter oldDelegate) => false;
}
