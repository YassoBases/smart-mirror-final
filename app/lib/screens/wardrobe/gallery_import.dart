import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:provider/provider.dart';
import '../../providers/auth_provider.dart';
import '../../providers/wardrobe_provider.dart';
import '../../services/api_service.dart';
import 'capture_item_screen.dart';

// Maximum number of photos imported from the gallery in one batch. Each is
// uploaded sequentially through the AI pipeline, so the cap keeps a single
// import bounded.
const int kMaxUploadBatch = 20;

// Imports one or several photos from the gallery into [profileId]'s closet.
//   - a single pick → upload then open the editor (same flow as camera capture)
//   - multiple picks → upload sequentially with a running progress dialog,
//     tolerating per-item failures and reporting a summary. Batch items skip the
//     editor; the user can refine attributes by tapping any item later.
Future<void> importFromGallery(BuildContext context, int profileId) async {
  final picker = ImagePicker();
  List<XFile> files;
  try {
    files = await picker.pickMultiImage(limit: kMaxUploadBatch);
  } catch (e) {
    if (context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Could not open gallery: $e')),
      );
    }
    return;
  }
  if (files.isEmpty || !context.mounted) return;

  // Enforce the cap client-side too — the picker's limit is not honoured on
  // every platform.
  final int picked = files.length;
  final bool truncated = picked > kMaxUploadBatch;
  if (truncated) files = files.sublist(0, kMaxUploadBatch);

  final api = context.read<AuthProvider>().api;

  if (files.length == 1) {
    await uploadAndOpenEditor(context, api, profileId, files.first.path);
    return;
  }

  await _batchUpload(context, api, profileId, files,
      truncatedFrom: truncated ? picked : null);
}

Future<void> _batchUpload(
  BuildContext context,
  ApiService api,
  int profileId,
  List<XFile> files, {
  int? truncatedFrom,
}) async {
  final progress = ValueNotifier<int>(0);
  showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (_) => _BatchProgressDialog(total: files.length, progress: progress),
  );

  final provider = context.read<WardrobeProvider>();
  int succeeded = 0;
  int failed = 0;

  for (var i = 0; i < files.length; i++) {
    try {
      final item = await api.uploadWardrobeItem(profileId, files[i].path);
      // Only mutate the visible closet if it is still this profile's.
      if (provider.profileId == profileId) {
        provider.addItem(item);
      }
      succeeded++;
    } catch (_) {
      failed++;
    }
    progress.value = i + 1;
  }

  progress.dispose();
  if (!context.mounted) return;
  Navigator.of(context, rootNavigator: true).pop(); // dismiss progress dialog

  final truncationNote = truncatedFrom != null
      ? ' Only the first $kMaxUploadBatch of $truncatedFrom were uploaded.'
      : '';
  final summary = failed == 0
      ? 'Added $succeeded items.$truncationNote '
          'Tap any item to refine its attributes.'
      : 'Added $succeeded items, $failed failed.$truncationNote '
          'Tap any item to refine its attributes.';
  ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(
      content: Text(summary),
      backgroundColor: failed == 0 ? null : Colors.orange[800],
    ),
  );
}

class _BatchProgressDialog extends StatelessWidget {
  final int total;
  final ValueNotifier<int> progress;
  const _BatchProgressDialog({required this.total, required this.progress});

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: Colors.grey[900],
      content: ValueListenableBuilder<int>(
        valueListenable: progress,
        builder: (_, done, __) => Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Uploading ${done.clamp(1, total)} of $total…',
                style: const TextStyle(color: Colors.white)),
            const SizedBox(height: 16),
            ClipRRect(
              borderRadius: BorderRadius.circular(4),
              child: LinearProgressIndicator(
                value: total == 0 ? null : done / total,
                color: Colors.white,
                backgroundColor: Colors.white24,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
