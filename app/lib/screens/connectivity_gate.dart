import 'dart:async';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import '../services/connectivity_service.dart';
import '../widgets/connection_error_view.dart';

enum _GateState { checking, online, offline }

class ConnectivityGate extends StatefulWidget {
  final Widget child;
  const ConnectivityGate({super.key, required this.child});

  @override
  State<ConnectivityGate> createState() => _ConnectivityGateState();
}

class _ConnectivityGateState extends State<ConnectivityGate> {
  _GateState _state = _GateState.checking;
  bool _inFlight = false;
  Timer? _retryTimer;
  StreamSubscription<List<ConnectivityResult>>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = Connectivity()
        .onConnectivityChanged
        .listen(_onConnectivityChange);
    _check();
  }

  void _onConnectivityChange(List<ConnectivityResult> _) {
    if (_state == _GateState.online) return;
    _check();
  }

  Future<void> _check() async {
    if (_inFlight) return;
    _inFlight = true;
    final reachable = await ConnectivityService.isBackendReachable();
    _inFlight = false;
    if (!mounted) return;

    if (reachable) {
      _retryTimer?.cancel();
      _retryTimer = null;
      setState(() => _state = _GateState.online);
    } else {
      if (_state != _GateState.offline) {
        setState(() => _state = _GateState.offline);
      }
      _scheduleRetry();
    }
  }

  void _scheduleRetry() {
    _retryTimer?.cancel();
    _retryTimer = Timer(const Duration(seconds: 5), _check);
  }

  @override
  void dispose() {
    _retryTimer?.cancel();
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return switch (_state) {
      _GateState.online => widget.child,
      _GateState.checking => const _CheckingScreen(),
      _GateState.offline => Scaffold(
          backgroundColor: Colors.black,
          body: SafeArea(
            child: ConnectionErrorView(onRetry: _check),
          ),
        ),
    };
  }
}

class _CheckingScreen extends StatelessWidget {
  const _CheckingScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      backgroundColor: Colors.black,
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.wb_sunny_outlined, size: 72, color: Colors.white),
            SizedBox(height: 24),
            Text(
              'Smart Mirror',
              style: TextStyle(
                color: Colors.white,
                fontSize: 28,
                fontWeight: FontWeight.bold,
                letterSpacing: 2,
              ),
            ),
            SizedBox(height: 32),
            CircularProgressIndicator(color: Colors.white54, strokeWidth: 2),
            SizedBox(height: 16),
            Text(
              'Connecting to your mirror…',
              style: TextStyle(color: Colors.white38, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}
