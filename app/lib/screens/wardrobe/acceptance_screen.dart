import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/acceptance_metrics.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/connection_error_view.dart';

// Optional demo screen: weekly suggestion-acceptance rate over time plus the
// time the model was last trained. Linked from the closet for the defense; safe
// to ignore if the backend does not implement /metrics/acceptance.
class AcceptanceScreen extends StatefulWidget {
  final int profileId;
  const AcceptanceScreen({super.key, required this.profileId});

  @override
  State<AcceptanceScreen> createState() => _AcceptanceScreenState();
}

class _AcceptanceScreenState extends State<AcceptanceScreen> {
  bool _loading = true;
  bool _connectionError = false;
  String? _error;
  AcceptanceMetrics? _metrics;

  @override
  void initState() {
    super.initState();
    _load();
  }

  ApiService get _api => context.read<AuthProvider>().api;

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _connectionError = false;
    });
    try {
      final m = await _api.getAcceptanceMetrics(widget.profileId);
      if (mounted) {
        setState(() {
          _metrics = m;
          _loading = false;
        });
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _error = e.message;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _connectionError = true;
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        iconTheme: const IconThemeData(color: Colors.white),
        title: const Text('Acceptance rate',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
      ),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: Colors.white));
    }
    if (_connectionError) {
      return ConnectionErrorView(onRetry: _load);
    }
    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_error!, style: const TextStyle(color: Colors.redAccent)),
            const SizedBox(height: 12),
            TextButton(
              onPressed: _load,
              child: const Text('Retry', style: TextStyle(color: Colors.white)),
            ),
          ],
        ),
      );
    }
    final metrics = _metrics;
    if (metrics == null || metrics.buckets.isEmpty) {
      return const Center(
        child: Text('No acceptance data yet.',
            style: TextStyle(color: Colors.white54, fontSize: 16)),
      );
    }

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        if (metrics.modelTrainedAt != null)
          Text(
            'Model last trained: ${metrics.modelTrainedAt}',
            style: const TextStyle(color: Colors.white54, fontSize: 13),
          ),
        const SizedBox(height: 20),
        for (final b in metrics.buckets) _bucketRow(b),
      ],
    );
  }

  Widget _bucketRow(AcceptanceBucket b) {
    final pct = (b.rate.clamp(0, 1) * 100).round();
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(b.weekStart ?? '—',
                  style: const TextStyle(color: Colors.white70, fontSize: 13)),
              Text('$pct%  (${b.accepted}/${b.total})',
                  style: const TextStyle(color: Colors.white54, fontSize: 12)),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: b.rate.clamp(0, 1).toDouble(),
              minHeight: 10,
              color: Colors.white,
              backgroundColor: Colors.white12,
            ),
          ),
        ],
      ),
    );
  }
}
