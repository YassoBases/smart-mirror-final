import 'dart:io';
import 'package:camera/camera.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../../models/wardrobe_item.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import 'item_editor_screen.dart';

const _kCaptureTips =
    'Lay the item flat on a plain white surface. Fill the frame. '
    'Use even lighting and avoid shadows.';
const _kExplainerSeenKey = 'wardrobe_capture_explainer_seen';

// Uploads [imagePath] as a new wardrobe item (background removal + captioning
// happen server-side), showing an "Analyzing item…" overlay, then opens the
// editor in confirm mode. The editor adds the item to WardrobeProvider on save.
// Returns the saved item if the user confirmed, else null. Shared by the camera
// capture flow and single-image gallery import.
Future<WardrobeItem?> uploadAndOpenEditor(
  BuildContext context,
  ApiService api,
  int profileId,
  String imagePath,
) async {
  showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => const _AnalyzingDialog(),
  );
  WardrobeItem item;
  try {
    item = await api.uploadWardrobeItem(profileId, imagePath);
  } on ApiException catch (e) {
    if (context.mounted) Navigator.of(context, rootNavigator: true).pop();
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.message), backgroundColor: Colors.red),
      );
    }
    return null;
  } catch (_) {
    if (context.mounted) Navigator.of(context, rootNavigator: true).pop();
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Connection error — could not upload item'),
          backgroundColor: Colors.red,
        ),
      );
    }
    return null;
  }
  if (!context.mounted) return null;
  Navigator.of(context, rootNavigator: true).pop(); // dismiss the overlay
  return Navigator.of(context).push<WardrobeItem>(
    MaterialPageRoute(
      builder: (_) => ItemEditorScreen(item: item, isNew: true),
    ),
  );
}

class _AnalyzingDialog extends StatelessWidget {
  const _AnalyzingDialog();

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: Colors.grey[900],
      content: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircularProgressIndicator(color: Colors.white),
          SizedBox(width: 20),
          Flexible(
            child: Text('Analyzing item…',
                style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );
  }
}

// Single-item camera capture. Reuses the camera lifecycle from face setup
// (init/teardown tied to dispose; rear camera) but with no ML Kit, no
// liveness, no multi-pose — just capture → preview → use/retake.
class CaptureItemScreen extends StatefulWidget {
  final int profileId;
  const CaptureItemScreen({super.key, required this.profileId});

  @override
  State<CaptureItemScreen> createState() => _CaptureItemScreenState();
}

class _CaptureItemScreenState extends State<CaptureItemScreen> {
  CameraController? _controller;
  bool _cameraReady = false;
  String? _error;
  String? _capturedPath; // set once a still is frozen for review
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _initializeCamera();
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeShowExplainer());
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  Future<void> _maybeShowExplainer() async {
    final prefs = await SharedPreferences.getInstance();
    if (prefs.getBool(_kExplainerSeenKey) == true) return;
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Colors.grey[900],
        title: const Text('Capturing an item',
            style: TextStyle(color: Colors.white)),
        content: const Text(
          'For the best results, lay the garment flat on a plain white '
          'surface, fill the frame, and use even lighting with no shadows. '
          'The background is removed automatically after capture.',
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
    await prefs.setBool(_kExplainerSeenKey, true);
  }

  Future<void> _initializeCamera() async {
    try {
      final cameras = await availableCameras();
      if (!mounted) return;
      if (cameras.isEmpty) {
        setState(() => _error = 'No cameras found on device.');
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
      if (mounted) setState(() => _error = 'Camera error: $e');
    }
  }

  Future<void> _capture() async {
    final ctrl = _controller;
    if (ctrl == null || !ctrl.value.isInitialized || _busy) return;
    setState(() => _busy = true);
    try {
      final XFile photo = await ctrl.takePicture();
      if (mounted) setState(() => _capturedPath = photo.path);
    } catch (e) {
      if (mounted) setState(() => _error = 'Capture failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _retake() {
    setState(() => _capturedPath = null);
  }

  Future<void> _usePhoto() async {
    final path = _capturedPath;
    if (path == null) return;
    final api = context.read<AuthProvider>().api;
    final saved =
        await uploadAndOpenEditor(context, api, widget.profileId, path);
    // Whether saved or the editor was dismissed, leave the capture screen so the
    // user returns to the closet. Pass the result up to the caller.
    if (mounted) Navigator.of(context).pop(saved);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        iconTheme: const IconThemeData(color: Colors.white),
        title: const Text('Add item',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
      ),
      body: SafeArea(
        child: Column(
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(16),
              color: Colors.grey[900],
              child: const Text(
                _kCaptureTips,
                style: TextStyle(color: Colors.white70, fontSize: 13),
                textAlign: TextAlign.center,
              ),
            ),
            Expanded(child: _preview()),
            _controls(),
          ],
        ),
      ),
    );
  }

  Widget _preview() {
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_error!,
                style: const TextStyle(color: Colors.redAccent),
                textAlign: TextAlign.center),
            const SizedBox(height: 12),
            ElevatedButton.icon(
              onPressed: () {
                setState(() {
                  _error = null;
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

    // Frozen still for review.
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
                child: CustomPaint(painter: _FrameOverlayPainter()),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _controls() {
    if (_error != null) return const SizedBox(height: 24);

    if (_capturedPath != null) {
      return Padding(
        padding: const EdgeInsets.all(20),
        child: Row(
          children: [
            Expanded(
              child: OutlinedButton(
                onPressed: _retake,
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
                onPressed: _usePhoto,
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.white,
                  foregroundColor: Colors.black,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
                child: const Text('Use photo',
                    style: TextStyle(fontWeight: FontWeight.w600)),
              ),
            ),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.all(20),
      child: GestureDetector(
        onTap: _cameraReady && !_busy ? _capture : null,
        child: Container(
          width: 72,
          height: 72,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Colors.white,
            border: Border.all(color: Colors.white54, width: 4),
          ),
          child: _busy
              ? const Padding(
                  padding: EdgeInsets.all(20),
                  child: CircularProgressIndicator(
                      strokeWidth: 2, color: Colors.black),
                )
              : const Icon(Icons.camera_alt, color: Colors.black, size: 32),
        ),
      ),
    );
  }
}

// Centered framing rectangle to help the user fill the frame with the garment.
class _FrameOverlayPainter extends CustomPainter {
  const _FrameOverlayPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Rect.fromCenter(
      center: Offset(size.width / 2, size.height / 2),
      width: size.width * 0.8,
      height: size.height * 0.8,
    );
    canvas.drawRRect(
      RRect.fromRectAndRadius(rect, const Radius.circular(12)),
      Paint()
        ..color = Colors.white70
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
  }

  @override
  bool shouldRepaint(_FrameOverlayPainter oldDelegate) => false;
}
