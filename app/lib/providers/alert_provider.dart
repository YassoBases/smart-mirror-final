import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/alert.dart';

class AlertProvider with ChangeNotifier {
  List<Alert> _alert = [];
  int _unreadCount = 0;
  bool _pendingAlertsNavigation = false;

  List<Alert> get alerts => _alert;
  int get unreadCount => _unreadCount;
  bool get pendingAlertsNavigation => _pendingAlertsNavigation;

  AlertProvider() {
    loadAlerts();
  }

  Future<void> loadAlerts() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.reload();
    final savedAlerts = prefs.getStringList('alerts') ?? [];

    _alert = savedAlerts.map((alertStr) {
      final data = jsonDecode(alertStr);
      return Alert(
        id: data['id'],
        title: data['title'],
        body: data['body'],
        timestamp: DateTime.parse(data['timestamp']),
      );
    }).toList();

    _unreadCount = prefs.getInt('alerts_unread') ?? 0;
    notifyListeners();
  }

  Future<void> addAlert(String title, String body) async {
    final newAlert = Alert(
      id: DateTime.now().millisecondsSinceEpoch.toString(),
      title: title,
      body: body,
      timestamp: DateTime.now(),
    );

    _alert.insert(0, newAlert);
    _unreadCount++;
    notifyListeners();

    await _saveToStorage();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setInt('alerts_unread', _unreadCount);
  }

  Future<void> clearAlert() async {
    _alert.clear();
    _unreadCount = 0;
    notifyListeners();

    final prefs = await SharedPreferences.getInstance();
    await prefs.remove('alerts');
    await prefs.setInt('alerts_unread', 0);
  }

  void markAllRead() {
    if (_unreadCount == 0) return;
    _unreadCount = 0;
    notifyListeners();
    SharedPreferences.getInstance()
        .then((p) => p.setInt('alerts_unread', 0));
  }

  // Called by NotificationService when a background notification is tapped —
  // MainNavigation listens and switches to the Alerts tab.
  void requestNavigateToAlerts() {
    _pendingAlertsNavigation = true;
    notifyListeners();
  }

  void clearNavigationRequest() {
    _pendingAlertsNavigation = false;
    // No notifyListeners — caller already owns the frame.
  }

  Future<void> _saveToStorage() async {
    final prefs = await SharedPreferences.getInstance();
    final encodedList = _alert.map((a) => jsonEncode({
          'id': a.id,
          'title': a.title,
          'body': a.body,
          'timestamp': a.timestamp.toIso8601String(),
        })).toList();

    await prefs.setStringList('alerts', encodedList);
  }
}
