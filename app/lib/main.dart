import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:firebase_core/firebase_core.dart';
import 'firebase_options.dart';
import 'services/notification_service.dart';
import 'providers/alert_provider.dart';

import 'providers/auth_provider.dart';
import 'providers/wardrobe_provider.dart';
import 'screens/splash_screen.dart';
import 'config/api.dart';

final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Restore a persisted backend URL (from QR provisioning or manual entry)
  // before anything makes an API call.
  await ApiConfig.load();

  // Firebase (and FCM push) only ship configs for Android/iOS. On desktop/web
  // there is no platform config and firebase_messaging is unsupported, so skip
  // init there — this lets the app run on Windows for testing without changing
  // mobile behavior.
  final supportsFirebase =
      !kIsWeb && (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);
  if (supportsFirebase) {
    await Firebase.initializeApp(
      options: DefaultFirebaseOptions.currentPlatform,
    );
    await NotificationService().initialize(navigatorKey);
  }

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => AuthProvider()),
        ChangeNotifierProvider(create: (_) => AlertProvider()),
        ChangeNotifierProvider(create: (_) => WardrobeProvider()),
      ],
      child: const SmartMirrorApp(),
    ),
  );
}

class SmartMirrorApp extends StatelessWidget {
  const SmartMirrorApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      navigatorKey: navigatorKey,
      title: 'Smart Mirror',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.dark(
          primary: Colors.white,
          surface: Colors.grey.shade900,
        ),
        scaffoldBackgroundColor: Colors.black,
        useMaterial3: true,
      ),
      home: const SplashScreen(),
    );
  }
}
