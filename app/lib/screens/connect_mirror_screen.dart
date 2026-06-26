import 'package:flutter/material.dart';
import 'connection_settings_screen.dart';
import 'pair_mirror_screen.dart';
import 'welcome_screen.dart';

/// First-run gate. Before any account exists the app has no backend address,
/// so login/signup can only fail. This screen blocks that dead-end: the user
/// scans the mirror's QR to provision the backend URL, and only then proceeds
/// to the welcome (sign-up / sign-in) flow.
class ConnectMirrorScreen extends StatelessWidget {
  const ConnectMirrorScreen({super.key});

  Future<void> _scan(BuildContext context) async {
    final ok = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => const PairMirrorScreen(provisionUrlOnly: true),
      ),
    );
    if (ok == true && context.mounted) _proceed(context);
  }

  // Secondary fallback when the QR can't be scanned (mirror off, camera denied).
  Future<void> _enterManually(BuildContext context) async {
    final ok = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => const ConnectionSettingsScreen(popOnSave: true),
      ),
    );
    if (ok == true && context.mounted) _proceed(context);
  }

  // Connected — move on to account creation / sign-in.
  void _proceed(BuildContext context) {
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => const WelcomeScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              const Spacer(),
              const Icon(Icons.qr_code_scanner, size: 56, color: Colors.white),
              const SizedBox(height: 24),
              const Text(
                'Connect to\nyour mirror',
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
                'Scan the QR code shown on your Smart Mirror so the app knows '
                'where to reach it. You only need to do this once.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white54, fontSize: 15),
              ),
              const Spacer(),
              SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton.icon(
                  onPressed: () => _scan(context),
                  icon: const Icon(Icons.qr_code_scanner, size: 20),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: Colors.black,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12)),
                  ),
                  label: const Text('Scan mirror QR',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                ),
              ),
              const SizedBox(height: 8),
              Center(
                child: TextButton(
                  onPressed: () => _enterManually(context),
                  child: const Text('Enter address manually',
                      style: TextStyle(color: Colors.white54, fontSize: 14)),
                ),
              ),
              const SizedBox(height: 6),
              const Center(
                child: Text(
                  'On the mirror, this is the “Welcome / Sign in” screen.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white24, fontSize: 12),
                ),
              ),
              const SizedBox(height: 24),
            ],
          ),
        ),
      ),
    );
  }
}
