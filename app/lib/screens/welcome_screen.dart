import 'package:flutter/material.dart';
import 'connection_settings_screen.dart';
import 'login_screen.dart';
import 'pair_mirror_screen.dart';
import 'onboarding/create_household_screen.dart';

class WelcomeScreen extends StatelessWidget {
  const WelcomeScreen({super.key});

  // Scans the mirror QR to provision the backend URL before onboarding.
  Future<void> _scanToConnect(BuildContext context) async {
    final ok = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => const PairMirrorScreen(provisionUrlOnly: true),
      ),
    );
    if (ok == true && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Connected — mirror address saved'),
          backgroundColor: Colors.green,
          duration: Duration(seconds: 2),
        ),
      );
    }
  }

  // Manual fallback if a returning user's mirror moved networks and the QR
  // isn't handy. Reuses the connection settings screen (with Test connection).
  void _enterManually(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => const ConnectionSettingsScreen()),
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
              const Icon(Icons.wb_sunny_outlined, size: 56, color: Colors.white),
              const SizedBox(height: 24),
              const Text(
                'Smart Mirror',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 36,
                  fontWeight: FontWeight.bold,
                  letterSpacing: 1,
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                'Manage your household profiles and mirror settings.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white54, fontSize: 15),
              ),
              const Spacer(),
              SizedBox(
                width: double.infinity,
                height: 52,
                child: ElevatedButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(
                        builder: (_) => const CreateHouseholdScreen()),
                  ),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: Colors.black,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12)),
                  ),
                  child: const Text('Get started',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                ),
              ),
              const SizedBox(height: 14),
              SizedBox(
                width: double.infinity,
                height: 52,
                child: OutlinedButton(
                  onPressed: () => Navigator.of(context).push(
                    MaterialPageRoute(builder: (_) => const LoginScreen()),
                  ),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Colors.white,
                    side: const BorderSide(color: Colors.white24),
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(12)),
                  ),
                  child: const Text('Sign in to existing account',
                      style:
                          TextStyle(fontSize: 16, fontWeight: FontWeight.w500)),
                ),
              ),
              const SizedBox(height: 16),
              // First-run helper: scan the mirror's QR to learn the backend
              // address before creating an account. Without this, onboarding
              // can't reach the backend on a network other than the built-in
              // default IP.
              Center(
                child: TextButton.icon(
                  onPressed: () => _scanToConnect(context),
                  icon: const Icon(Icons.qr_code_scanner,
                      color: Colors.white54, size: 18),
                  label: const Text('Scan mirror QR to connect',
                      style: TextStyle(color: Colors.white54, fontSize: 14)),
                ),
              ),
              Center(
                child: TextButton(
                  onPressed: () => _enterManually(context),
                  child: const Text('Enter address manually',
                      style: TextStyle(color: Colors.white38, fontSize: 13)),
                ),
              ),
              const SizedBox(height: 16),
            ],
          ),
        ),
      ),
    );
  }
}
