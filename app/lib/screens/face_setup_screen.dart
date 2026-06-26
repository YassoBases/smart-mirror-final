import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:camera/camera.dart';
import 'package:provider/provider.dart';
import 'package:google_mlkit_face_detection/google_mlkit_face_detection.dart';
import '../providers/auth_provider.dart';
import '../models/profile.dart';
import '../services/api_service.dart';
import '../widgets/connection_error_view.dart';

// ── Pose stages ───────────────────────────────────────────────────────────────
enum _Pose { front, left, right, uploading, done }

enum _BlinkPhase { awaitOpen, awaitClose, awaitReopen, done }

// ── Tuning constants ──────────────────────────────────────────────────────────
// Set _kYawSignFlip = true if left/right guidance appears swapped on device.
const _kYawSignFlip = false;
const _kFrontYawMax = 12.0; // °
const _kFrontPitchMax = 15.0;
const _kSidePoseYawMin = 25.0; // ° from center for left/right capture
const _kSidePitchMax = 20.0;
const _kFaceHeightMin = 0.28; // face bbox height / preview height
const _kSteadyFrames = 8; // consecutive OK frames before capture
const _kBurstShots = 4; // still frames captured per pose for richer face descriptors
const _kRequireBlink = true; // blink liveness check on front pose

class FaceSetupScreen extends StatefulWidget {
  final bool isActive;
  final Profile? initialProfile;
  const FaceSetupScreen(
      {super.key, required this.isActive, this.initialProfile});

  @override
  State<FaceSetupScreen> createState() => _FaceSetupScreenState();
}

class _FaceSetupScreenState extends State<FaceSetupScreen> {
  // Camera
  CameraController? _cameraController;
  bool _cameraReady = false;

  // ML Kit detector (created once, reused across poses)
  late final FaceDetector _faceDetector;
  bool _processingFrame = false;

  // Pose state machine
  _Pose _pose = _Pose.front;
  final List<String> _capturedPaths = [];

  // Steadiness tracking
  int _steadyCount = 0;
  int? _steadyTrackingId;
  bool _capturing = false;

  // Blink liveness (front pose only)
  bool _blinkDone = false;
  _BlinkPhase _blinkPhase = _BlinkPhase.awaitOpen;

  bool _updateRequested = false;
  bool get _needsEnrollment =>
      _updateRequested || !(_selectedProfile?.hasFace ?? false);

  // Live guidance label
  String _guidance = 'Look straight ahead';

  // Error text
  String? _error;

  // Profile selection
  List<Profile> _profiles = [];
  Profile? _selectedProfile;
  bool _isLoadingProfiles = true;
  bool _profilesConnectionFailed = false;
  String? _profilesApiError;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  @override
  void initState() {
    super.initState();
    _faceDetector = FaceDetector(
      options: FaceDetectorOptions(
        performanceMode: FaceDetectorMode.fast,
        enableClassification: true, // needed for eye-open probabilities
        enableTracking: true,
        minFaceSize: 0.15,
      ),
    );
    _loadProfiles();
  }

  @override
  void didUpdateWidget(FaceSetupScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.isActive && !oldWidget.isActive) {
      if (_needsEnrollment && _pose != _Pose.done) _initializeCamera();
    } else if (!widget.isActive && oldWidget.isActive) {
      final ctrl = _cameraController;
      _cameraController = null;
      if (ctrl != null) {
        ctrl.stopImageStream().catchError((_) {}).then((_) => ctrl.dispose());
      }
      if (mounted) setState(() => _cameraReady = false);
    }
  }

  @override
  void dispose() {
    _faceDetector.close();
    _cameraController?.dispose();
    super.dispose();
  }

  // ── Profiles ─────────────────────────────────────────────────────────────────

  Future<void> _loadProfiles() async {
    if (mounted) {
      setState(() {
        _isLoadingProfiles = true;
        _profilesConnectionFailed = false;
        _profilesApiError = null;
      });
    }
    try {
      final api = context.read<AuthProvider>().api;
      final profiles = await api.listProfiles();
      if (mounted) {
        setState(() {
          _profiles = profiles;
          _selectedProfile = (widget.initialProfile != null
                  ? profiles
                      .where((p) => p.id == widget.initialProfile!.id)
                      .firstOrNull
                  : null) ??
              (profiles.isNotEmpty ? profiles.first : null);
          _isLoadingProfiles = false;
        });
        if (widget.isActive && _needsEnrollment) _initializeCamera();
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          if (e is ApiException) {
            _profilesApiError = e.message;
          } else {
            _profilesConnectionFailed = true;
          }
          _isLoadingProfiles = false;
        });
      }
    }
  }

  // ── Camera ─────────────────────────────────────────────────────────────────

  Future<void> _initializeCamera() async {
    try {
      final cameras = await availableCameras();
      if (!mounted) return;
      if (cameras.isEmpty) {
        setState(() => _error = 'No cameras found on device.');
        return;
      }
      final frontCamera = cameras.firstWhere(
        (cam) => cam.lensDirection == CameraLensDirection.front,
        orElse: () => cameras.first,
      );
      _cameraController = CameraController(
        frontCamera,
        ResolutionPreset.high,
        enableAudio: false,
        imageFormatGroup: ImageFormatGroup.nv21, // Android NV21 for ML Kit
      );
      await _cameraController!.initialize();
      if (!mounted) return;
      setState(() => _cameraReady = true);
      _cameraController!.startImageStream(_onCameraImage);
    } catch (e) {
      if (mounted) setState(() => _error = 'Camera error: $e');
    }
  }

  // ── Frame processing ────────────────────────────────────────────────────────

  void _onCameraImage(CameraImage image) {
    if (_processingFrame) return;
    if (_pose == _Pose.uploading || _pose == _Pose.done) return;
    _processingFrame = true;
    _runDetection(image).whenComplete(() => _processingFrame = false);
  }

  Future<void> _runDetection(CameraImage image) async {
    final ctrl = _cameraController;
    if (ctrl == null || !ctrl.value.isInitialized) return;

    final InputImage inputImage = _buildInputImage(image, ctrl);
    List<Face> faces;
    try {
      faces = await _faceDetector.processImage(inputImage);
    } catch (_) {
      return;
    }
    if (!mounted) return;
    _evaluateFrame(faces, image.height);
  }

  InputImage _buildInputImage(CameraImage image, CameraController ctrl) {
    // Concatenate all planes — NV21: Y plane then interleaved VU plane
    int totalBytes = 0;
    for (final plane in image.planes) {
      totalBytes += plane.bytes.length;
    }
    final allBytes = Uint8List(totalBytes);
    int offset = 0;
    for (final plane in image.planes) {
      allBytes.setRange(offset, offset + plane.bytes.length, plane.bytes);
      offset += plane.bytes.length;
    }

    return InputImage.fromBytes(
      bytes: allBytes,
      metadata: InputImageMetadata(
        size: Size(image.width.toDouble(), image.height.toDouble()),
        rotation: _sensorRotation(ctrl.description.sensorOrientation),
        format: InputImageFormat.nv21,
        bytesPerRow: image.planes[0].bytesPerRow,
      ),
    );
  }

  InputImageRotation _sensorRotation(int deg) => switch (deg) {
        90 => InputImageRotation.rotation90deg,
        180 => InputImageRotation.rotation180deg,
        270 => InputImageRotation.rotation270deg,
        _ => InputImageRotation.rotation0deg,
      };

  // ── Pose evaluation ─────────────────────────────────────────────────────────

  void _evaluateFrame(List<Face> faces, int previewHeight) {
    // Quality gate: exactly one face
    if (faces.length != 1) {
      _resetSteady();
      _setGuidance(_guidanceText(_pose, angleOk: false, awaitBlink: false));
      return;
    }

    final face = faces.first;

    // Quality gate: face must fill a meaningful portion of the frame
    if ((face.boundingBox.height / previewHeight) < _kFaceHeightMin) {
      _resetSteady();
      _setGuidance('Move closer to the camera');
      return;
    }

    // Blink liveness check (front pose only)
    if (_pose == _Pose.front && _kRequireBlink) {
      _updateBlink(face);
      if (!_blinkDone) {
        _resetSteady();
        _setGuidance('Please blink once');
        return;
      }
    }

    // Head-angle check
    final double rawYaw = face.headEulerAngleY ?? 0.0;
    final double yaw = _kYawSignFlip ? -rawYaw : rawYaw;
    final double pitch = face.headEulerAngleX ?? 0.0;
    final bool angleOk = _angleOk(_pose, yaw, pitch);

    if (!angleOk) {
      _resetSteady();
      _setGuidance(_guidanceText(_pose, angleOk: false, awaitBlink: false));
      return;
    }

    // Steadiness: same trackingId held for _kSteadyFrames consecutive frames
    final int? trackId = face.trackingId;
    if (trackId != null && trackId == _steadyTrackingId) {
      _steadyCount++;
    } else {
      _steadyTrackingId = trackId;
      _steadyCount = 1;
    }
    _setGuidance(_guidanceText(_pose, angleOk: true, awaitBlink: false));

    if (_steadyCount >= _kSteadyFrames && !_capturing) {
      _capturing = true;
      _captureCurrentPose();
    }
  }

  bool _angleOk(_Pose pose, double yaw, double pitch) => switch (pose) {
        _Pose.front =>
          yaw.abs() <= _kFrontYawMax && pitch.abs() <= _kFrontPitchMax,
        // Front-camera: user turns head LEFT → positive yaw in ML Kit coords
        _Pose.left =>
          yaw >= _kSidePoseYawMin && pitch.abs() <= _kSidePitchMax,
        _Pose.right =>
          yaw <= -_kSidePoseYawMin && pitch.abs() <= _kSidePitchMax,
        _ => false,
      };

  void _updateBlink(Face face) {
    final double leftOpen = face.leftEyeOpenProbability ?? 1.0;
    final double rightOpen = face.rightEyeOpenProbability ?? 1.0;
    final double avg = (leftOpen + rightOpen) / 2.0;

    switch (_blinkPhase) {
      case _BlinkPhase.awaitOpen:
        if (avg > 0.6) _blinkPhase = _BlinkPhase.awaitClose;
      case _BlinkPhase.awaitClose:
        if (avg < 0.2) _blinkPhase = _BlinkPhase.awaitReopen;
      case _BlinkPhase.awaitReopen:
        if (avg > 0.6) {
          _blinkPhase = _BlinkPhase.done;
          if (mounted) setState(() => _blinkDone = true);
        }
      case _BlinkPhase.done:
        break;
    }
  }

  void _resetSteady() {
    _steadyCount = 0;
    _steadyTrackingId = null;
  }

  void _setGuidance(String text) {
    if (_guidance != text && mounted) {
      setState(() => _guidance = text);
    }
  }

  // ── Capture ─────────────────────────────────────────────────────────────────

  Future<void> _captureCurrentPose() async {
    final ctrl = _cameraController;
    if (ctrl == null || !ctrl.value.isInitialized) {
      _capturing = false;
      return;
    }
    try {
      await ctrl.stopImageStream();
      for (int i = 0; i < _kBurstShots; i++) {
        final XFile photo = await ctrl.takePicture();
        _capturedPaths.add(photo.path);
        if (i < _kBurstShots - 1) {
          await Future.delayed(const Duration(milliseconds: 120));
        }
      }

      if (!mounted) {
        _capturing = false;
        return;
      }

      final nextPose = _advance(_pose);
      if (nextPose == _Pose.uploading) {
        setState(() {
          _pose = _Pose.uploading;
          _guidance = 'Uploading…';
        });
        await _uploadAll();
      } else {
        setState(() {
          _pose = nextPose;
          _guidance = _guidanceText(nextPose, angleOk: false, awaitBlink: false);
          _steadyCount = 0;
          _steadyTrackingId = null;
          _capturing = false;
        });
        ctrl.startImageStream(_onCameraImage);
      }
    } catch (e) {
      _capturing = false;
      if (mounted) setState(() => _error = e.toString());
      try {
        _cameraController?.startImageStream(_onCameraImage);
      } catch (_) {}
    }
  }

  _Pose _advance(_Pose current) => switch (current) {
        _Pose.front => _Pose.left,
        _Pose.left => _Pose.right,
        _Pose.right => _Pose.uploading,
        _ => _Pose.done,
      };

  Future<void> _uploadAll() async {
    try {
      final api = context.read<AuthProvider>().api;
      await api.uploadFaces(_selectedProfile!.id, _capturedPaths);
      if (mounted) {
        setState(() {
          _pose = _Pose.done;
          _guidance = 'All done!';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _pose = _Pose.front;
          _guidance = 'Look straight ahead';
          _capturing = false;
        });
        try {
          _cameraController?.startImageStream(_onCameraImage);
        } catch (_) {}
      }
    }
  }

  // ── Reset ────────────────────────────────────────────────────────────────────

  Future<void> _resetScan() async {
    final ctrl = _cameraController;
    _cameraController = null;
    if (ctrl != null) {
      try {
        await ctrl.stopImageStream();
      } catch (_) {}
      ctrl.dispose();
    }
    if (!mounted) return;
    setState(() {
      _cameraReady = false;
      _pose = _Pose.front;
      _capturedPaths.clear();
      _steadyCount = 0;
      _steadyTrackingId = null;
      _blinkDone = false;
      _blinkPhase = _BlinkPhase.awaitOpen;
      _guidance = 'Look straight ahead';
      _error = null;
      _capturing = false;
      _processingFrame = false;
    });
    _initializeCamera();
  }

  // ── Guidance text ────────────────────────────────────────────────────────────

  String _guidanceText(_Pose pose,
      {required bool angleOk, required bool awaitBlink}) {
    if (awaitBlink) return 'Please blink once';
    return switch (pose) {
      _Pose.front => angleOk ? 'Hold still…' : 'Look straight ahead',
      _Pose.left => angleOk ? 'Hold still…' : 'Slowly turn left',
      _Pose.right => angleOk ? 'Hold still…' : 'Slowly turn right',
      _Pose.uploading => 'Uploading…',
      _Pose.done => 'All done!',
    };
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    if (_profilesConnectionFailed) {
      return ConnectionErrorView(onRetry: _loadProfiles);
    }

    if (_profilesApiError != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_profilesApiError!,
                style: const TextStyle(color: Colors.redAccent),
                textAlign: TextAlign.center),
            const SizedBox(height: 12),
            TextButton(
              onPressed: _loadProfiles,
              child: const Text('Retry',
                  style: TextStyle(color: Colors.white)),
            ),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.all(24.0),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Biometric Setup',
            textAlign: TextAlign.center,
            style: TextStyle(
                fontSize: 24,
                fontWeight: FontWeight.bold,
                color: Colors.white),
          ),
          const SizedBox(height: 8),
          const Text(
            'Follow the prompts to register your face from three angles.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white54),
          ),
          const SizedBox(height: 20),

          _buildProfileSelector(),
          const SizedBox(height: 20),

          if (!_needsEnrollment)
            _buildAlreadyEnrolledCard()
          else ...[
            _buildProgressRow(),
            const SizedBox(height: 12),

            Text(
              _guidance,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white70, fontSize: 16),
            ),
            const SizedBox(height: 12),

            _buildCameraArea(),

            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!,
                  style: const TextStyle(color: Colors.redAccent),
                  textAlign: TextAlign.center),
            ],

            const SizedBox(height: 20),

            if (_pose == _Pose.done)
              _buildDoneActions()
            else if (!_cameraReady && _error != null)
              ElevatedButton.icon(
                onPressed: _resetScan,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry Camera'),
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  backgroundColor: Colors.white,
                  foregroundColor: Colors.black,
                ),
              ),
          ],
        ],
      ),
    );
  }

  Widget _buildProfileSelector() {
    if (_isLoadingProfiles) {
      return const Center(
          child: CircularProgressIndicator(color: Colors.white));
    }
    if (_profiles.isEmpty) {
      return const Text(
        'No profiles found. Please create one first.',
        textAlign: TextAlign.center,
        style: TextStyle(color: Colors.redAccent),
      );
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.grey[900],
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white24),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<Profile>(
          value: _selectedProfile,
          dropdownColor: Colors.grey[900],
          isExpanded: true,
          icon: const Icon(Icons.arrow_drop_down, color: Colors.white),
          style: const TextStyle(color: Colors.white, fontSize: 16),
          items: _profiles
              .map((p) =>
                  DropdownMenuItem<Profile>(value: p, child: Text(p.name)))
              .toList(),
          onChanged: _pose == _Pose.front
              ? (Profile? p) {
                  if (p == null) return;
                  setState(() {
                    _selectedProfile = p;
                    _updateRequested = false;
                  });
                  if (_needsEnrollment) {
                    _resetScan();
                  } else {
                    final ctrl = _cameraController;
                    _cameraController = null;
                    if (ctrl != null) {
                      ctrl
                          .stopImageStream()
                          .catchError((_) {})
                          .then((_) => ctrl.dispose());
                    }
                    if (mounted) setState(() => _cameraReady = false);
                  }
                }
              : null,
        ),
      ),
    );
  }

  Widget _buildProgressRow() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        _stepChip('Front', _Pose.front),
        _stepDivider(_isStepDone(_Pose.front)),
        _stepChip('Left', _Pose.left),
        _stepDivider(_isStepDone(_Pose.left)),
        _stepChip('Right', _Pose.right),
      ],
    );
  }

  bool _isStepDone(_Pose step) {
    const order = [
      _Pose.front,
      _Pose.left,
      _Pose.right,
      _Pose.uploading,
      _Pose.done
    ];
    return order.indexOf(_pose) > order.indexOf(step);
  }

  Widget _stepChip(String label, _Pose step) {
    final bool done = _isStepDone(step);
    final bool active = _pose == step;
    return Column(
      children: [
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: done
                ? Colors.green
                : active
                    ? Colors.white
                    : Colors.white24,
          ),
          child: Icon(
            done ? Icons.check : Icons.circle_outlined,
            size: 18,
            color: active ? Colors.black : Colors.white,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          label,
          style: TextStyle(
            color: active ? Colors.white : Colors.white54,
            fontSize: 12,
          ),
        ),
      ],
    );
  }

  Widget _stepDivider(bool filled) => Container(
        width: 40,
        height: 2,
        margin: const EdgeInsets.only(bottom: 16),
        color: filled ? Colors.green : Colors.white24,
      );

  Widget _buildCameraArea() {
    return AspectRatio(
      aspectRatio: 3 / 4,
      child: Stack(
        fit: StackFit.expand,
        children: [
          Container(
            decoration: BoxDecoration(
              color: Colors.black,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: _borderColor(), width: 2),
            ),
            clipBehavior: Clip.hardEdge,
            child: _cameraContent(),
          ),
          Positioned.fill(
            child: IgnorePointer(
              child: CustomPaint(
                painter: _OvalOverlayPainter(color: _overlayColor()),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Color _borderColor() {
    if (_pose == _Pose.done) return Colors.green;
    if (_pose == _Pose.uploading) return Colors.blue;
    if (_steadyCount > 3) return Colors.blue;
    return Colors.white24;
  }

  Color _overlayColor() {
    if (_pose == _Pose.done) return Colors.green;
    if (_steadyCount >= _kSteadyFrames ~/ 2) return Colors.blue;
    return Colors.white54;
  }

  Widget _cameraContent() {
    if (_pose == _Pose.done) {
      return const Center(
          child: Icon(Icons.check_circle, size: 80, color: Colors.green));
    }
    if (_pose == _Pose.uploading) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(color: Colors.blue),
            SizedBox(height: 12),
            Text('Uploading…', style: TextStyle(color: Colors.white60)),
          ],
        ),
      );
    }
    if (_cameraController == null || !_cameraReady) {
      return const Center(
          child: CircularProgressIndicator(color: Colors.white));
    }
    final preview = _cameraController!.value.previewSize;
    if (preview == null) {
      return const Center(child: CircularProgressIndicator(color: Colors.white));
    }
    return FittedBox(
      fit: BoxFit.cover,
      clipBehavior: Clip.hardEdge,
      child: SizedBox(
        width: preview.height, // previewSize is sensor-landscape; swap for portrait
        height: preview.width,
        child: CameraPreview(_cameraController!),
      ),
    );
  }

  Widget _buildDoneActions() {
    return Column(
      children: [
        const Text(
          'Face registered!',
          textAlign: TextAlign.center,
          style: TextStyle(
              color: Colors.green,
              fontSize: 18,
              fontWeight: FontWeight.bold),
        ),
        const SizedBox(height: 12),
        TextButton(
          onPressed: _resetScan,
          child: const Text('Retake Scan',
              style: TextStyle(color: Colors.white54)),
        ),
      ],
    );
  }

  Widget _buildAlreadyEnrolledCard() {
    return Card(
      color: Colors.grey[900],
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: Padding(
        padding: const EdgeInsets.all(24.0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.verified_user, color: Colors.green, size: 48),
            const SizedBox(height: 16),
            const Text(
              'Face setup complete',
              style: TextStyle(
                color: Colors.white,
                fontSize: 18,
                fontWeight: FontWeight.bold,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              'You\'ve already registered your face for '
              '${_selectedProfile?.name ?? 'this profile'}. '
              'You can update it with a fresh scan anytime.',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white60, fontSize: 14),
            ),
            const SizedBox(height: 20),
            ElevatedButton.icon(
              onPressed: _startUpdate,
              icon: const Icon(Icons.refresh),
              label: const Text('Update Face Setup'),
              style: ElevatedButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _startUpdate() async {
    setState(() => _updateRequested = true);
    await _resetScan();
  }
}

// ── Oval overlay ──────────────────────────────────────────────────────────────
class _OvalOverlayPainter extends CustomPainter {
  final Color color;
  const _OvalOverlayPainter({required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    canvas.drawOval(
      Rect.fromCenter(
        center: Offset(size.width / 2, size.height / 2),
        width: size.width * 0.55,
        height: size.height * 0.82,
      ),
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3.0,
    );
  }

  @override
  bool shouldRepaint(_OvalOverlayPainter old) => old.color != color;
}
