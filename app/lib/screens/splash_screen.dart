import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:smart_mirror_app/screens/main_navigation.dart';
import '../config/api.dart';
import '../providers/auth_provider.dart';
import 'connectivity_gate.dart';
import 'onboarding/ble_setup_screen.dart';
import 'welcome_screen.dart';

// Shown while we check for a stored JWT. Routes to home or onboarding.
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _navigate();
  }

  Future<void> _navigate() async {
    final auth = context.read<AuthProvider>();
    await auth.init();
    if (!mounted) return;

    // Routing priority:
    //   1. Already signed in        → straight to the app.
    //   2. Never connected a mirror → first-run gate (must provision a backend
    //      URL before login/signup, which would otherwise just fail).
    //   3. Connected, not signed in → normal welcome (sign up / sign in).
    final Widget next;
    if (auth.isLoggedIn) {
      next = const ConnectivityGate(child: MainNavigation());
    } else if (!ApiConfig.isProvisioned) {
      next = const BleSetupScreen();
    } else {
      next = const WelcomeScreen();
    }

    Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => next));
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: Colors.black,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.wb_sunny_outlined, size: 72, color: Colors.white),
            SizedBox(height: 16),
            Text(
              'Smart Mirror',
              style: TextStyle(
                color: Colors.white,
                fontSize: 28,
                fontWeight: FontWeight.bold,
                letterSpacing: 2,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
