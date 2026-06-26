import 'dart:async';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/api_service.dart';
import '../services/notification_service.dart';

class AuthProvider extends ChangeNotifier {
  String? _token;
  bool _loading = true;

  String? get token => _token;
  bool get isLoggedIn => _token != null;
  bool get loading => _loading;

  // Returns an ApiService pre-loaded with the current token
  ApiService get api => ApiService(token: _token);

  // Called once at app startup to restore a saved session
  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    _token = prefs.getString('jwt_token');
    _loading = false;
    // Wire token-rotation callback so mid-session FCM refreshes re-register.
    NotificationService.onTokenRefreshed = registerFcmToken;
    // Register the FCM token now that we have a JWT (token may have arrived at app start)
    if (_token != null) {
      final fcmToken = NotificationService.lastToken;
      if (fcmToken != null) unawaited(registerFcmToken(fcmToken));
    }
    notifyListeners();
  }

  Future<void> saveToken(String token) async {
    _token = token;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('jwt_token', token);
    // Register FCM token now that we have a JWT
    final fcmToken = NotificationService.lastToken;
    if (fcmToken != null) unawaited(registerFcmToken(fcmToken));
    notifyListeners();
  }

  Future<void> logout() async {
    // Unregister the FCM token while we still have a valid JWT.
    final fcmToken = NotificationService.lastToken;
    if (fcmToken != null && _token != null) {
      try {
        await api.unregisterDeviceToken(fcmToken);
      } catch (_) {}
    }
    _token = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('jwt_token');
    notifyListeners();
  }

  // Registers (or refreshes) the device's FCM token with the backend.
  // No-op when not logged in.
  Future<void> registerFcmToken(String token) async {
    if (_token == null) return;
    try {
      await api.registerDeviceToken(token);
    } catch (_) {}
  }
}
