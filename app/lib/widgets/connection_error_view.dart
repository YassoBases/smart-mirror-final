import 'package:flutter/material.dart';
import '../screens/connection_settings_screen.dart';

class ConnectionErrorView extends StatelessWidget {
  final VoidCallback onRetry;
  final bool showSettings;
  final String? message;

  const ConnectionErrorView({
    super.key,
    required this.onRetry,
    this.showSettings = true,
    this.message,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off, size: 64, color: Colors.white54),
            const SizedBox(height: 24),
            const Text(
              "Can't reach your mirror",
              style: TextStyle(
                color: Colors.white,
                fontSize: 22,
                fontWeight: FontWeight.bold,
              ),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            Text(
              message ??
                  'Make sure your mirror is powered on and your phone is on the '
                  'same network — your home WiFi, or your phone\'s hotspot '
                  'if that\'s what the mirror uses.',
              style: const TextStyle(
                  color: Colors.white54, fontSize: 14, height: 1.5),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 32),
            SizedBox(
              width: double.infinity,
              height: 50,
              child: ElevatedButton(
                onPressed: onRetry,
                style: ElevatedButton.styleFrom(
                  backgroundColor: Colors.white,
                  foregroundColor: Colors.black,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12)),
                ),
                child: const Text(
                  'Try again',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                ),
              ),
            ),
            if (showSettings) ...[
              const SizedBox(height: 8),
              TextButton(
                onPressed: () async {
                  await Navigator.of(context).push(MaterialPageRoute(
                    builder: (_) => const ConnectionSettingsScreen(),
                  ));
                  onRetry();
                },
                child: const Text(
                  'Connection settings',
                  style: TextStyle(color: Colors.white38, fontSize: 14),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
