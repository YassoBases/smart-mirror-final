import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../config/api.dart';
import '../models/security_alert.dart';
import '../providers/alert_provider.dart';
import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import 'welcome_screen.dart';

class AlertScreen extends StatefulWidget {
  const AlertScreen({super.key});

  @override
  State<AlertScreen> createState() => _AlertScreenState();
}

class _AlertScreenState extends State<AlertScreen>
    with WidgetsBindingObserver {
  List<SecurityAlert> _alerts = [];
  bool _loading = true;
  String? _error;

  // Derived from ApiConfig.baseUrl by stripping the trailing "/api" segment.
  String get _serverBase {
    final base = ApiConfig.baseUrl;
    return base.endsWith('/api') ? base.substring(0, base.length - 4) : base;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _fetch();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  // Re-fetch when the app comes back to the foreground.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _fetch();
  }

  Future<void> _fetch() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final api = context.read<AuthProvider>().api;
      final alerts = await api.getAlerts();
      if (mounted) {
        setState(() => _alerts = alerts);
        // Mark all FCM-badge alerts as read now that the user sees the list.
        context.read<AlertProvider>().markAllRead();
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.statusCode == 401) {
        await _handleUnauthorized();
        return;
      }
      setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not load alerts.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _handleUnauthorized() async {
    await context.read<AuthProvider>().logout();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const WelcomeScreen()),
      (_) => false,
    );
  }

  Future<void> _sendTestAlert() async {
    final mirrorId = _alerts.isNotEmpty ? _alerts.first.mirrorId : 'test-mirror';
    try {
      await context.read<AuthProvider>().api.sendTestAlert(mirrorId);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('Test alert sent — refresh in a moment'),
          backgroundColor: Colors.green,
        ),
      );
      // Delay slightly so the backend has time to write the row.
      await Future.delayed(const Duration(seconds: 2));
      _fetch();
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.statusCode == 401) {
        await _handleUnauthorized();
        return;
      }
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.message), backgroundColor: Colors.red),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Security Alerts'),
        backgroundColor: Colors.transparent,
        actions: [
          IconButton(
            icon: const Icon(Icons.science_outlined),
            tooltip: 'Send test alert',
            onPressed: _sendTestAlert,
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
            onPressed: _fetch,
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.cloud_off, size: 48, color: Colors.white38),
              const SizedBox(height: 16),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: const TextStyle(color: Colors.white54),
              ),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: _fetch,
                icon: const Icon(Icons.refresh),
                label: const Text('Retry'),
              ),
            ],
          ),
        ),
      );
    }
    if (_alerts.isEmpty) {
      return RefreshIndicator(
        onRefresh: _fetch,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          children: const [
            SizedBox(height: 120),
            Center(
              child: Column(
                children: [
                  Icon(Icons.shield_outlined, size: 64, color: Colors.white24),
                  SizedBox(height: 16),
                  Text(
                    'No alerts yet. Everything is secure.',
                    style: TextStyle(color: Colors.white54, fontSize: 16),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    return RefreshIndicator(
      onRefresh: _fetch,
      child: ListView.builder(
        padding: const EdgeInsets.only(bottom: 16),
        itemCount: _alerts.length,
        itemBuilder: (context, index) => _AlertCard(
          alert: _alerts[index],
          serverBase: _serverBase,
        ),
      ),
    );
  }
}

class _AlertCard extends StatelessWidget {
  const _AlertCard({required this.alert, required this.serverBase});

  final SecurityAlert alert;
  final String serverBase;

  @override
  Widget build(BuildContext context) {
    final local = alert.timestamp.toLocal();
    final dateStr =
        '${local.year}-${_p(local.month)}-${_p(local.day)}  ${_p(local.hour)}:${_p(local.minute)}';

    final imageUrl =
        (alert.imageUrl != null && alert.imageUrl!.isNotEmpty)
            ? '$serverBase${alert.imageUrl}'
            : null;

    return Card(
      color: Colors.grey.shade900,
      margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Snapshot image (only when the backend stored one)
          if (imageUrl != null)
            Image.network(
              imageUrl,
              height: 180,
              width: double.infinity,
              fit: BoxFit.cover,
              errorBuilder: (_, __, ___) => Container(
                height: 80,
                color: Colors.grey.shade800,
                child: const Center(
                  child: Icon(Icons.broken_image, color: Colors.white24),
                ),
              ),
            ),

          Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Alert type label + icon
                Row(
                  children: [
                    const Icon(Icons.warning_amber_rounded,
                        color: Colors.redAccent, size: 20),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        alert.typeLabel,
                        style: const TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 15,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                _InfoRow(Icons.videocam_outlined, 'Mirror', alert.mirrorId),
                _InfoRow(Icons.schedule, 'Time', dateStr),
                if (alert.confidence != null)
                  _InfoRow(
                    Icons.percent,
                    'Confidence',
                    '${(alert.confidence! * 100).toStringAsFixed(1)} %',
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  static String _p(int v) => v.toString().padLeft(2, '0');
}

class _InfoRow extends StatelessWidget {
  const _InfoRow(this.icon, this.label, this.value);

  final IconData icon;
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Row(
        children: [
          Icon(icon, size: 14, color: Colors.white38),
          const SizedBox(width: 6),
          Text('$label: ', style: const TextStyle(color: Colors.white54, fontSize: 13)),
          Expanded(
            child: Text(
              value,
              style: const TextStyle(fontSize: 13),
              overflow: TextOverflow.ellipsis,
            ),
          ),
        ],
      ),
    );
  }
}
