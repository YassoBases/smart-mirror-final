import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/outfit_feedback.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/connection_error_view.dart';

// Paginated list of past outfit feedback (thumbs up/down) for a profile.
class FeedbackHistoryScreen extends StatefulWidget {
  final int profileId;
  const FeedbackHistoryScreen({super.key, required this.profileId});

  @override
  State<FeedbackHistoryScreen> createState() => _FeedbackHistoryScreenState();
}

const _pageSize = 50;

class _FeedbackHistoryScreenState extends State<FeedbackHistoryScreen> {
  final List<OutfitFeedback> _items = [];
  bool _loading = false;
  bool _connectionError = false;
  String? _error;
  bool _hasMore = true;

  @override
  void initState() {
    super.initState();
    _loadMore(reset: true);
  }

  ApiService get _api => context.read<AuthProvider>().api;

  Future<void> _loadMore({bool reset = false}) async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
      _connectionError = false;
      if (reset) {
        _items.clear();
        _hasMore = true;
      }
    });
    try {
      final page = await _api.getOutfitFeedback(
        widget.profileId,
        limit: _pageSize,
        offset: _items.length,
      );
      if (!mounted) return;
      setState(() {
        _items.addAll(page);
        _hasMore = page.length == _pageSize;
        _loading = false;
      });
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
        title: const Text('Feedback history',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
      ),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    if (_connectionError && _items.isEmpty) {
      return ConnectionErrorView(onRetry: () => _loadMore(reset: true));
    }
    if (_error != null && _items.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_error!, style: const TextStyle(color: Colors.redAccent)),
            const SizedBox(height: 12),
            TextButton(
              onPressed: () => _loadMore(reset: true),
              child:
                  const Text('Retry', style: TextStyle(color: Colors.white)),
            ),
          ],
        ),
      );
    }
    if (_loading && _items.isEmpty) {
      return const Center(child: CircularProgressIndicator(color: Colors.white));
    }
    if (_items.isEmpty) {
      return const Center(
        child: Text('No feedback yet.',
            style: TextStyle(color: Colors.white54, fontSize: 16)),
      );
    }

    return RefreshIndicator(
      onRefresh: () => _loadMore(reset: true),
      color: Colors.white,
      backgroundColor: Colors.grey[900],
      child: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: _items.length + (_hasMore ? 1 : 0),
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (_, i) {
          if (i >= _items.length) {
            // Trailing load-more row.
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Center(
                child: _loading
                    ? const CircularProgressIndicator(color: Colors.white)
                    : TextButton(
                        onPressed: _loadMore,
                        child: const Text('Load more',
                            style: TextStyle(color: Colors.white)),
                      ),
              ),
            );
          }
          return _FeedbackTile(feedback: _items[i]);
        },
      ),
    );
  }
}

class _FeedbackTile extends StatelessWidget {
  final OutfitFeedback feedback;
  const _FeedbackTile({required this.feedback});

  @override
  Widget build(BuildContext context) {
    final up = feedback.rating == 'up';
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.grey[900],
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: [
          Icon(
            up ? Icons.thumb_up : Icons.thumb_down,
            color: up ? Colors.greenAccent : Colors.redAccent,
            size: 20,
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  feedback.isGenerated
                      ? 'Generated outfit · ${feedback.pieceCount} piece'
                          '${feedback.pieceCount == 1 ? '' : 's'}'
                      : '${feedback.pieceCount} item'
                          '${feedback.pieceCount == 1 ? '' : 's'}',
                  style: const TextStyle(
                      color: Colors.white, fontWeight: FontWeight.w600),
                ),
                if (feedback.createdAt != null) ...[
                  const SizedBox(height: 4),
                  Text(
                    _formatDate(feedback.createdAt!),
                    style: const TextStyle(color: Colors.white54, fontSize: 12),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  // Renders an ISO timestamp as YYYY-MM-DD HH:MM, falling back to the raw string.
  String _formatDate(String raw) {
    final dt = DateTime.tryParse(raw);
    if (dt == null) return raw;
    final local = dt.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)} '
        '${two(local.hour)}:${two(local.minute)}';
  }
}
