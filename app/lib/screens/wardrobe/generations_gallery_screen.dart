import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/generated_outfit.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';

// Gallery of saved "render on me" generations — every outfit the AI rendered
// onto the user's body photo, newest first. Tap to view full screen; long-press
// to delete. Backed by GET/DELETE /outfit/generations.
class GenerationsGalleryScreen extends StatefulWidget {
  final int profileId;
  const GenerationsGalleryScreen({super.key, required this.profileId});

  @override
  State<GenerationsGalleryScreen> createState() =>
      _GenerationsGalleryScreenState();
}

class _GenerationsGalleryScreenState extends State<GenerationsGalleryScreen> {
  ApiService get _api => context.read<AuthProvider>().api;

  List<Generation> _items = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final items = await _api.listGenerations(widget.profileId);
      if (!mounted) return;
      setState(() {
        _items = items;
        _loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _delete(Generation g) async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF1A1A1A),
        title: const Text('Delete this look?',
            style: TextStyle(color: Colors.white)),
        content: const Text('It will be removed from your gallery.',
            style: TextStyle(color: Colors.white70)),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Delete',
                  style: TextStyle(color: Colors.redAccent))),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await _api.deleteGeneration(widget.profileId, g.id);
      if (!mounted) return;
      setState(() => _items.removeWhere((x) => x.id == g.id));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Could not delete: $e')));
    }
  }

  void _openFull(Generation g) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => _FullGenerationView(generation: g),
    ));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        title: const Text('My Looks',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        iconTheme: const IconThemeData(color: Colors.white),
      ),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(
          child: CircularProgressIndicator(color: Colors.white54));
    }
    if (_error != null) {
      return _centered(Icons.error_outline, _error!, Colors.redAccent);
    }
    if (_items.isEmpty) {
      return _centered(
          Icons.auto_awesome,
          'No looks yet. Generate an outfit in Discover to see yourself '
              'wearing it — your renders are saved here.',
          Colors.white54);
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: GridView.builder(
        padding: const EdgeInsets.all(12),
        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
          crossAxisCount: 2,
          childAspectRatio: 0.62,
          crossAxisSpacing: 12,
          mainAxisSpacing: 12,
        ),
        itemCount: _items.length,
        itemBuilder: (_, i) => _tile(_items[i]),
      ),
    );
  }

  Widget _tile(Generation g) {
    final url = g.imageUrl;
    return GestureDetector(
      onTap: () => _openFull(g),
      onLongPress: () => _delete(g),
      child: Container(
        decoration: BoxDecoration(
          color: Colors.grey[900],
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: Colors.white12),
        ),
        clipBehavior: Clip.hardEdge,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: url == null
                  ? const Icon(Icons.checkroom, color: Colors.white24)
                  : Image.network(url, fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => const Icon(
                          Icons.broken_image, color: Colors.white24)),
            ),
            Padding(
              padding: const EdgeInsets.all(8),
              child: Text(
                g.title ?? 'Outfit',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: Colors.white, fontSize: 12),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _centered(IconData icon, String msg, Color color) {
    return ListView(
      // ListView so RefreshIndicator/empty state still scroll on small screens.
      padding: const EdgeInsets.all(32),
      children: [
        const SizedBox(height: 80),
        Icon(icon, size: 56, color: color.withValues(alpha: 0.6)),
        const SizedBox(height: 16),
        Text(msg,
            textAlign: TextAlign.center,
            style: TextStyle(color: color, fontSize: 15)),
      ],
    );
  }
}

// Full-screen view of one saved look with its item list.
class _FullGenerationView extends StatelessWidget {
  final Generation generation;
  const _FullGenerationView({required this.generation});

  @override
  Widget build(BuildContext context) {
    final url = generation.imageUrl;
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        iconTheme: const IconThemeData(color: Colors.white),
        title: Text(generation.title ?? 'Outfit',
            style: const TextStyle(color: Colors.white)),
      ),
      body: SafeArea(
        child: ListView(
          children: [
            if (url != null)
              InteractiveViewer(
                child: Image.network(url, fit: BoxFit.contain,
                    errorBuilder: (_, __, ___) => const SizedBox(
                        height: 300,
                        child: Icon(Icons.broken_image,
                            color: Colors.white24, size: 48))),
              ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: generation.items
                    .map((it) => Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: Text(
                            '• ${it.description ?? it.subcategory ?? it.category}',
                            style: const TextStyle(
                                color: Colors.white70, fontSize: 14),
                          ),
                        ))
                    .toList(),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
