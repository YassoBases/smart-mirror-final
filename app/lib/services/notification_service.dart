import 'dart:convert';
import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/alert_provider.dart';

@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  debugPrint("🚨 BACKGROUND ALERT RECEIVED (App is sleeping) 🚨");
  
  final prefs = await SharedPreferences.getInstance();
  final savedAlerts = prefs.getStringList('alerts') ?? [];

  final newAlert = {
    'id': DateTime.now().millisecondsSinceEpoch.toString(),
    'title': message.notification?.title ?? 'Security Alert',
    'body': message.notification?.body ?? 'An event occurred at the mirror.',
    'timestamp': DateTime.now().toIso8601String(),
  };

  savedAlerts.insert(0, jsonEncode(newAlert));
  await prefs.setStringList('alerts', savedAlerts);
  await prefs.setInt('alerts_unread', (prefs.getInt('alerts_unread') ?? 0) + 1);
}

class NotificationService {
  final FirebaseMessaging _firebaseMessaging = FirebaseMessaging.instance;

  // Stored after the first getToken() call; AuthProvider reads this when
  // it has a JWT so it can register the token with the backend.
  static String? lastToken;

  // Set by AuthProvider.init() so token rotations re-register with the backend.
  static void Function(String)? onTokenRefreshed;

  Future<void> initialize(GlobalKey<NavigatorState> navigatorKey) async {
    // Register the background handler first so an alert arriving during
    // startup isn't missed.
    FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);

    final settings = await _firebaseMessaging.requestPermission(
      alert: true, badge: true, sound: true,
    );
    debugPrint(
        '[Notifications] permission: ${settings.authorizationStatus}');

    try {
      final token = await _firebaseMessaging.getToken();
      if (kDebugMode) debugPrint('\n🚨 YOUR FCM DEVICE TOKEN: $token\n');
      if (token != null) lastToken = token;
    } catch (e) {
      debugPrint('Failed to get FCM token: $e');
    }

    // Registered in a non-async method: these callbacks fire on later message
    // events, not as continuations of this method's awaits, so using the
    // navigator context inside them is safe.
    _attachMessageListeners(navigatorKey);
  }

  void _attachMessageListeners(GlobalKey<NavigatorState> navigatorKey) {
    FirebaseMessaging.onMessage.listen((RemoteMessage message) {
      debugPrint('🚨 FOREGROUND ALERT RECEIVED 🚨');
      
      final context = navigatorKey.currentContext;
      if (message.notification != null && context != null && context.mounted) {
        final title = message.notification!.title ?? 'Security Alert';
        final body = message.notification!.body ?? 'An event occurred at the mirror.';

        Provider.of<AlertProvider>(context, listen: false).addAlert(title, body);
        
        showDialog(
          context: context,
          builder: (context) => AlertDialog(
            icon: const Icon(Icons.warning_amber_rounded, color: Colors.red, size: 40),
            title: Text(title),
            content: Text(body),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(context).pop(),
                child: const Text('DISMISS', style: TextStyle(color: Colors.white)),
              ),
            ],
          ),
        );
      }
    });

    FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
      debugPrint('🚨 BACKGROUND NOTIFICATION TAPPED 🚨');

      final context = navigatorKey.currentContext;
      if (context != null && context.mounted) {
        final alertProvider =
            Provider.of<AlertProvider>(context, listen: false);
        alertProvider.loadAlerts();
        // Ask MainNavigation to switch to the Alerts tab.
        alertProvider.requestNavigateToAlerts();
      }
    });

    _firebaseMessaging.onTokenRefresh.listen((newToken) {
      debugPrint('FCM Token Refreshed: $newToken');
      lastToken = newToken;
      onTokenRefreshed?.call(newToken);
    });
  }
}