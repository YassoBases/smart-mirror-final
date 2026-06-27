import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';
import '../../models/generated_outfit.dart';
import '../../models/outfit_context.dart';
import '../../models/profile.dart';
import '../../providers/auth_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/connection_error_view.dart';
import 'generations_gallery_screen.dart';
import 'wardrobe_home_screen.dart' show parseHexColor;

// "Discover" tab: the AI invents brand-new outfit ideas (not from the closet),
// shows a generated preview image per item, and links out to where to buy each
// one. Likes/dislikes feed the same preference model so ideas improve over time.
class DiscoverScreen extends StatefulWidget {
  final bool isActive;
  const DiscoverScreen({super.key, this.isActive = true});

  @override
  State<DiscoverScreen> createState() => _DiscoverScreenState();
}

class _DiscoverScreenState extends State<DiscoverScreen> {
  // Profiles
  List<Profile> _profiles = [];
  Profile? _selectedProfile;
  bool _loadingProfiles = true;
  bool _profilesConnectionError = false;
  String? _profilesError;

  // Generation
  bool _loading = false;
  bool _connectionError = false;
  String? _error;
  List<GeneratedCandidate> _candidates = [];
  OutfitContext _context = OutfitContext();
  int _index = 0;
  String _occasion = kOccasions.first; // "any"
  final Set<int> _ratedIndexes = {};

  @override
  void initState() {
    super.initState();
    _loadProfiles();
  }

  ApiService get _api => context.read<AuthProvider>().api;

  Future<void> _loadProfiles() async {
    setState(() {
      _loadingProfiles = true;
      _profilesConnectionError = false;
      _profilesError = null;
    });
    try {
      final profiles = await _api.listProfiles();
      if (!mounted) return;
      setState(() {
        _profiles = profiles;
        _selectedProfile = profiles.isNotEmpty ? profiles.first : null;
        _loadingProfiles = false;
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _profilesError = e.message;
          _loadingProfiles = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _profilesConnectionError = true;
          _loadingProfiles = false;
        });
      }
    }
  }

  GeneratedCandidate? get _current =>
      (_index >= 0 && _index < _candidates.length) ? _candidates[_index] : null;

  Future<void> _generate() async {
    final id = _selectedProfile?.id;
    if (id == null) return;
    setState(() {
      _loading = true;
      _error = null;
      _connectionError = false;
    });
    try {
      final result = await _api.generateOutfit(
        id,
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

  Future<void> _openShop(GeneratedItem item) async {
    final url = item.searchUrl;
    if (url == null || url.isEmpty) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Could not open the shopping link')),
        );
      }
    }
  }

  Future<void> _sendFeedback(String rating) async {
    final candidate = _current;
    final id = _selectedProfile?.id;
    if (candidate == null || id == null) return;
    try {
      await _api.sendGeneratedFeedback(
        id,
        items: candidate.items,
        rating: rating,
        reasoningShown: candidate.reasoning,
        context: _context,
      );
      if (!mounted) return;
      setState(() => _ratedIndexes.add(_index));
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
            content: Text(rating == 'up'
                ? 'Thanks — more looks like this'
                : 'Thanks — fewer looks like this')),
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

  void _page(int delta) {
    final next = _index + delta;
    if (next < 0 || next >= _candidates.length) return;
    setState(() => _index = next);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        title: const Text('Discover',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        actions: [
          IconButton(
            tooltip: 'My Looks',
            icon: const Icon(Icons.photo_library_outlined, color: Colors.white),
            onPressed: _openGallery,
          ),
        ],
      ),
      body: SafeArea(child: _body()),
    );
  }

  Widget _body() {
    if (_loadingProfiles) {
      return const Center(child: CircularProgressIndicator(color: Colors.white));
    }
    if (_profilesConnectionError) {
      return ConnectionErrorView(onRetry: _loadProfiles);
    }
    if (_profilesError != null) {
      return _inlineError(_profilesError!, _loadProfiles);
    }
    if (_profiles.isEmpty) {
      return const Center(
        child: Text('No profiles found. Create one first.',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.white54, fontSize: 16)),
      );
    }
    if (_connectionError) {
      return ConnectionErrorView(onRetry: _generate);
    }
    if (_loading) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(color: Colors.white),
            SizedBox(height: 12),
            Text('Designing new outfits…',
                style: TextStyle(color: Colors.white54)),
          ],
        ),
      );
    }
    return _candidates.isEmpty ? _initialOrError() : _candidateView();
  }

  Widget _header() {
    return Column(
      children: [
        if (_profiles.length > 1)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: _profileSelector(),
          ),
        _occasionSelector(),
      ],
    );
  }

  Widget _initialOrError() {
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        _header(),
        const SizedBox(height: 24),
        const Icon(Icons.auto_awesome, size: 56, color: Colors.white24),
        const SizedBox(height: 16),
        Text(
          _error ??
              'Generate brand-new outfit ideas to shop for, tuned to the '
                  'weather and your chosen occasion.',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: _error != null ? Colors.redAccent : Colors.white54,
            fontSize: 15,
          ),
        ),
        const SizedBox(height: 24),
        Center(child: _generateButton()),
      ],
    );
  }

  void _openGallery() {
    final id = _selectedProfile?.id;
    if (id == null) return;
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => GenerationsGalleryScreen(profileId: id),
    ));
  }

  // Big "this is you wearing it" image at the top of a candidate, when the
  // outfit was rendered onto the body photo.
  Widget _tryOnHero(GeneratedCandidate candidate) {
    final url = candidate.tryOnUrl;
    if (url == null) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(16),
        child: Image.network(
          url,
          fit: BoxFit.cover,
          loadingBuilder: (_, child, progress) => progress == null
              ? child
              : Container(
                  height: 320,
                  color: Colors.white10,
                  child: const Center(
                      child: CircularProgressIndicator(color: Colors.white24)),
                ),
          errorBuilder: (_, __, ___) => const SizedBox.shrink(),
        ),
      ),
    );
  }

  Widget _candidateView() {
    final candidate = _current!;
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        _header(),
        const SizedBox(height: 12),
        _contextChips(),
        const SizedBox(height: 16),
        _tryOnHero(candidate),
        ...candidate.items.map(_itemCard),
        const SizedBox(height: 8),
        if (candidate.reasoning.isNotEmpty)
          Text(candidate.reasoning,
              style: const TextStyle(color: Colors.white70, fontSize: 14)),
        const SizedBox(height: 16),
        _pager(),
        const SizedBox(height: 16),
        _actions(),
        const SizedBox(height: 12),
        Center(child: _generateButton(label: 'Generate again')),
      ],
    );
  }

  Widget _itemCard(GeneratedItem item) {
    final url = item.imageUrl;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      decoration: BoxDecoration(
        color: Colors.grey[900],
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: Colors.white12),
      ),
      clipBehavior: Clip.hardEdge,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 110,
            height: 130,
            child: url == null
                ? Container(
                    color: Colors.white10,
                    child: const Icon(Icons.checkroom,
                        color: Colors.white24, size: 36),
                  )
                : Image.network(
                    url,
                    fit: BoxFit.cover,
                    errorBuilder: (_, __, ___) => Container(
                      color: Colors.white10,
                      child: const Icon(Icons.broken_image,
                          color: Colors.white24, size: 36),
                    ),
                  ),
          ),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        width: 14,
                        height: 14,
                        decoration: BoxDecoration(
                          color: parseHexColor(item.primaryColor) ??
                              Colors.transparent,
                          shape: BoxShape.circle,
                          border: Border.all(color: Colors.white24),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Expanded(
                        child: Text(
                          item.subcategory ?? item.category,
                          style: const TextStyle(
                              color: Colors.white,
                              fontSize: 14,
                              fontWeight: FontWeight.w600),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Text(
                    item.description ?? item.category,
                    style: const TextStyle(color: Colors.white54, fontSize: 12),
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  const Spacer(),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton.icon(
                      onPressed: () => _openShop(item),
                      icon: const Icon(Icons.shopping_bag_outlined, size: 16),
                      label: const Text('Shop'),
                      style: TextButton.styleFrom(
                        foregroundColor: Colors.white,
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _profileSelector() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.grey[900],
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white24),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<Profile>(
          value: _selectedProfile,
          dropdownColor: Colors.grey[900],
          isExpanded: true,
          icon: const Icon(Icons.arrow_drop_down, color: Colors.white),
          style: const TextStyle(color: Colors.white, fontSize: 16),
          items: _profiles
              .map((p) =>
                  DropdownMenuItem<Profile>(value: p, child: Text(p.name)))
              .toList(),
          onChanged: (p) {
            if (p == null || p.id == _selectedProfile?.id) return;
            setState(() {
              _selectedProfile = p;
              _candidates = [];
              _index = 0;
              _ratedIndexes.clear();
            });
          },
        ),
      ),
    );
  }

  Widget _occasionSelector() {
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
            onSelected: (_) => setState(() => _occasion = o),
          ),
      ],
    );
  }

  Widget _generateButton({String label = 'Generate new outfit'}) {
    return ElevatedButton.icon(
      onPressed: _generate,
      icon: const Icon(Icons.auto_awesome),
      label: Text(label),
      style: ElevatedButton.styleFrom(
        backgroundColor: Colors.white,
        foregroundColor: Colors.black,
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      ),
    );
  }

  Widget _contextChips() {
    final chips = <String>[
      if (_context.temperature != null) '${_context.temperature!.round()}°C',
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
    return Row(
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
    );
  }

  Widget _inlineError(String message, VoidCallback onRetry) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message,
              style: const TextStyle(color: Colors.redAccent),
              textAlign: TextAlign.center),
          const SizedBox(height: 12),
          TextButton(
            onPressed: onRetry,
            child: const Text('Retry', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );
  }
}
