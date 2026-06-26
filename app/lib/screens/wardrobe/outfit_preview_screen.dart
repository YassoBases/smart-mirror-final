import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/outfit_candidate.dart';
import '../../models/outfit_context.dart';
import '../../models/wardrobe_item.dart';
import '../../providers/auth_provider.dart';
import '../../providers/wardrobe_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/connection_error_view.dart';
import 'wardrobe_home_screen.dart' show parseHexColor;

// Phone-side outfit preview (the mirror is the primary surface). Suggest an
// outfit, page through candidates, render it on the user's body photo, and send
// thumbs up/down feedback. Item thumbnails are resolved from the closet already
// loaded in WardrobeProvider.
class OutfitPreviewScreen extends StatefulWidget {
  final int profileId;
  const OutfitPreviewScreen({super.key, required this.profileId});

  @override
  State<OutfitPreviewScreen> createState() => _OutfitPreviewScreenState();
}

class _OutfitPreviewScreenState extends State<OutfitPreviewScreen> {
  bool _loading = false;
  bool _connectionError = false;
  String? _error;

  List<OutfitCandidate> _candidates = [];
  OutfitContext _context = OutfitContext();
  int _index = 0;
  String _occasion = kOccasions.first; // "any"

  // Render-on-me state. The board stays visible while a render is in flight.
  bool _rendering = false;
  String? _renderUrl;
  String? _renderError;

  // Tracks which candidates have already received feedback this session.
  final Set<int> _ratedIndexes = {};

  ApiService get _api => context.read<AuthProvider>().api;

  Future<void> _suggest() async {
    setState(() {
      _loading = true;
      _error = null;
      _connectionError = false;
      _renderUrl = null;
      _renderError = null;
    });
    try {
      final result = await _api.suggestOutfit(
        widget.profileId,
        occasion: _occasion == 'any' ? null : _occasion,
      );
      if (!mounted) return;
      setState(() {
        _candidates = result.candidates;
        _context = result.context;
        _index = 0;
        _ratedIndexes.clear();
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

  Future<void> _render() async {
    final candidate = _current;
    if (candidate == null) return;
    setState(() {
      _rendering = true;
      _renderError = null;
    });
    try {
      final result = await _api.renderOutfit(widget.profileId, candidate.itemIds);
      if (!mounted) return;
      setState(() {
        _renderUrl = result.renderUrl.isEmpty ? null : result.renderUrl;
        if (_renderUrl == null) {
          _renderError = 'The render did not return an image.';
        }
      });
    } on ApiException catch (e) {
      if (mounted) setState(() => _renderError = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _renderError = 'Connection error — could not render');
      }
    } finally {
      if (mounted) setState(() => _rendering = false);
    }
  }

  Future<void> _sendFeedback(String rating) async {
    final candidate = _current;
    if (candidate == null) return;
    try {
      await _api.sendOutfitFeedback(
        widget.profileId,
        itemIds: candidate.itemIds,
        rating: rating,
        // The board always shows the reasoning, so echo that text back.
        reasoningShown: candidate.reasoning,
        context: _context,
      );
      if (!mounted) return;
      setState(() => _ratedIndexes.add(_index));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            content: Text(rating == 'up'
                ? 'Thanks — noted you liked this'
                : 'Thanks — noted this missed')),
      );
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Connection error — could not send feedback'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  OutfitCandidate? get _current =>
      (_index >= 0 && _index < _candidates.length) ? _candidates[_index] : null;

  void _page(int delta) {
    final next = _index + delta;
    if (next < 0 || next >= _candidates.length) return;
    setState(() {
      _index = next;
      _renderUrl = null;
      _renderError = null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        iconTheme: const IconThemeData(color: Colors.white),
        title: const Text('Outfit preview',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
      ),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    if (_connectionError) {
      return ConnectionErrorView(onRetry: _suggest);
    }
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: Colors.white));
    }
    if (_candidates.isEmpty) {
      return _initialOrError();
    }
    return _candidateView();
  }

  Widget _initialOrError() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.auto_awesome, size: 56, color: Colors.white24),
            const SizedBox(height: 16),
            Text(
              _error ??
                  'Get an outfit suggestion based on your closet and today\'s '
                      'weather.',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: _error != null ? Colors.redAccent : Colors.white54,
                fontSize: 15,
              ),
            ),
            const SizedBox(height: 24),
            const Text('Occasion',
                style: TextStyle(color: Colors.white70, fontSize: 13)),
            const SizedBox(height: 8),
            _occasionSelector(),
            const SizedBox(height: 24),
            ElevatedButton.icon(
              onPressed: _suggest,
              icon: const Icon(Icons.auto_awesome),
              label: const Text('Suggest an outfit'),
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
                padding:
                    const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // Occasion picker. Re-suggests when changed if a suggestion is already shown.
  Widget _occasionSelector({bool resuggestOnChange = false}) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      alignment: WrapAlignment.center,
      children: [
        for (final o in kOccasions)
          ChoiceChip(
            label: Text(o),
            selected: _occasion == o,
            backgroundColor: Colors.grey[900],
            selectedColor: Colors.white24,
            labelStyle: const TextStyle(color: Colors.white),
            side: const BorderSide(color: Colors.white24),
            onSelected: (_) {
              if (_occasion == o) return;
              setState(() => _occasion = o);
              if (resuggestOnChange) _suggest();
            },
          ),
      ],
    );
  }

  Widget _candidateView() {
    final candidate = _current!;
    final provider = context.watch<WardrobeProvider>();
    final byId = {for (final it in provider.items) it.id: it};

    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        _occasionSelector(resuggestOnChange: true),
        const SizedBox(height: 12),
        _contextChips(),
        const SizedBox(height: 16),
        if (_renderUrl != null || _rendering)
          _renderArea()
        else
          _outfitBoard(candidate, byId),
        const SizedBox(height: 12),
        if (candidate.reasoning.isNotEmpty)
          Text(
            candidate.reasoning,
            style: const TextStyle(color: Colors.white70, fontSize: 14),
          ),
        if (_renderError != null) ...[
          const SizedBox(height: 8),
          Text(_renderError!,
              style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
        ],
        const SizedBox(height: 16),
        _pager(),
        const SizedBox(height: 16),
        _actions(),
      ],
    );
  }

  Widget _contextChips() {
    final chips = <String>[
      if (_context.temperature != null)
        '${_context.temperature!.round()}°C',
      if (_context.weather != null) _context.weather!,
      if (_context.timeOfDay != null) _context.timeOfDay!,
      if (_context.season != null) _context.season!,
      if (_context.occasion != null) _context.occasion!,
    ];
    if (chips.isEmpty) return const SizedBox.shrink();
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final c in chips)
          Chip(
            label: Text(c, style: const TextStyle(color: Colors.white)),
            backgroundColor: Colors.grey[900],
            side: const BorderSide(color: Colors.white24),
          ),
      ],
    );
  }

  Widget _outfitBoard(OutfitCandidate candidate, Map<int, WardrobeItem> byId) {
    return GridView.count(
      crossAxisCount: 2,
      shrinkWrap: true,
      physics: const NeverScrollableScrollPhysics(),
      mainAxisSpacing: 12,
      crossAxisSpacing: 12,
      childAspectRatio: 0.85,
      children: [
        for (final id in candidate.itemIds) _boardTile(byId[id]),
      ],
    );
  }

  Widget _boardTile(WardrobeItem? item) {
    final url = item?.thumbnailUrl;
    return Container(
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
                ? Container(
                    color: Colors.white10,
                    child: const Center(
                      child: Icon(Icons.checkroom,
                          color: Colors.white24, size: 32),
                    ),
                  )
                : Image.network(
                    url,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => Container(
                      color: Colors.white10,
                      child: const Center(
                        child: Icon(Icons.broken_image,
                            color: Colors.white24, size: 32),
                      ),
                    ),
                  ),
          ),
          if (item != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              child: Row(
                children: [
                  Container(
                    width: 12,
                    height: 12,
                    decoration: BoxDecoration(
                      color: parseHexColor(item.primaryColor) ??
                          Colors.transparent,
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white24),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(item.category,
                        style: const TextStyle(
                            color: Colors.white, fontSize: 12),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _renderArea() {
    return AspectRatio(
      aspectRatio: 3 / 4,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(16),
        child: Stack(
          fit: StackFit.expand,
          children: [
            if (_renderUrl != null)
              Image.network(
                _renderUrl!,
                fit: BoxFit.contain,
                errorBuilder: (_, __, ___) => Container(
                  color: Colors.white10,
                  child: const Center(
                    child: Icon(Icons.broken_image,
                        color: Colors.white24, size: 48),
                  ),
                ),
              )
            else
              Container(color: Colors.white10),
            if (_rendering)
              Container(
                color: Colors.black54,
                child: const Center(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      CircularProgressIndicator(color: Colors.white),
                      SizedBox(height: 12),
                      Text('Rendering…',
                          style: TextStyle(color: Colors.white70)),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _pager() {
    if (_candidates.length <= 1) return const SizedBox.shrink();
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        IconButton(
          onPressed: _index > 0 ? () => _page(-1) : null,
          icon: const Icon(Icons.chevron_left, color: Colors.white),
        ),
        Text('${_index + 1} of ${_candidates.length}',
            style: const TextStyle(color: Colors.white70)),
        IconButton(
          onPressed: _index < _candidates.length - 1 ? () => _page(1) : null,
          icon: const Icon(Icons.chevron_right, color: Colors.white),
        ),
      ],
    );
  }

  Widget _actions() {
    final rated = _ratedIndexes.contains(_index);
    return Column(
      children: [
        Row(
          children: [
            Expanded(
              child: OutlinedButton.icon(
                onPressed: rated ? null : () => _sendFeedback('up'),
                icon: const Icon(Icons.thumb_up_alt_outlined),
                label: const Text('Like'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.white,
                  side: const BorderSide(color: Colors.white54),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: OutlinedButton.icon(
                onPressed: rated ? null : () => _sendFeedback('down'),
                icon: const Icon(Icons.thumb_down_alt_outlined),
                label: const Text('Dislike'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: Colors.white,
                  side: const BorderSide(color: Colors.white54),
                  padding: const EdgeInsets.symmetric(vertical: 14),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        SizedBox(
          width: double.infinity,
          child: ElevatedButton.icon(
            onPressed: _rendering ? null : _render,
            icon: const Icon(Icons.person_outline),
            label: const Text('Render on me'),
            style: ElevatedButton.styleFrom(
              backgroundColor: Colors.white,
              foregroundColor: Colors.black,
              padding: const EdgeInsets.symmetric(vertical: 14),
            ),
          ),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: _loading ? null : _suggest,
          child: const Text('Suggest again',
              style: TextStyle(color: Colors.white54)),
        ),
      ],
    );
  }
}
