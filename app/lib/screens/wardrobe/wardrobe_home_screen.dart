import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/profile.dart';
import '../../models/wardrobe_item.dart';
import '../../providers/auth_provider.dart';
import '../../providers/wardrobe_provider.dart';
import '../../services/api_service.dart';
import '../../widgets/connection_error_view.dart';
import 'acceptance_screen.dart';
import 'body_photo_screen.dart';
import 'capture_item_screen.dart';
import 'feedback_history_screen.dart';
import 'gallery_import.dart';
import 'item_editor_screen.dart';
import 'outfit_preview_screen.dart';

// The closet: a per-profile grid of wardrobe items. Profile picker at top (when
// the household has more than one), responsive thumbnail grid, empty/error
// states matching the rest of the app, and an add sheet (camera / gallery,
// wired in Phase 3). The app bar exposes the base body photo (Phase 4).
class WardrobeHomeScreen extends StatefulWidget {
  final bool isActive;
  const WardrobeHomeScreen({super.key, this.isActive = true});

  @override
  State<WardrobeHomeScreen> createState() => _WardrobeHomeScreenState();
}

class _WardrobeHomeScreenState extends State<WardrobeHomeScreen> {
  List<Profile> _profiles = [];
  Profile? _selectedProfile;
  bool _loadingProfiles = true;
  bool _profilesConnectionError = false;
  String? _profilesError;
  bool _bodyPhotoSet = false; // drives the app-bar checkmark

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
      final selected = _selectedProfile;
      if (selected != null) {
        final provider = context.read<WardrobeProvider>();
        provider.selectProfile(selected.id);
        _loadBodyPhoto(selected.id);
        await provider.load(_api);
      }
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

  Future<void> _onProfileChanged(Profile? p) async {
    if (p == null || p.id == _selectedProfile?.id) return;
    setState(() {
      _selectedProfile = p;
      _bodyPhotoSet = false;
    });
    final provider = context.read<WardrobeProvider>();
    provider.selectProfile(p.id);
    _loadBodyPhoto(p.id);
    await provider.load(_api);
  }

  Future<void> _refresh() async {
    await context.read<WardrobeProvider>().load(_api);
  }

  // Checks whether the selected profile already has a base body photo, to show a
  // checkmark on the app-bar action. Connectivity/API failures just leave the
  // indicator off.
  Future<void> _loadBodyPhoto(int profileId) async {
    try {
      final url = await _api.getBodyPhoto(profileId);
      if (mounted && _selectedProfile?.id == profileId) {
        setState(() => _bodyPhotoSet = url != null && url.isNotEmpty);
      }
    } catch (_) {
      // ignore — the indicator simply stays off
    }
  }

  Future<void> _openBodyPhoto() async {
    final id = _selectedProfile?.id;
    if (id == null) return;
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => BodyPhotoScreen(profileId: id)),
    );
    if (saved == true && mounted) setState(() => _bodyPhotoSet = true);
  }

  void _openOutfitPreview() {
    final id = _selectedProfile?.id;
    if (id == null) return;
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => OutfitPreviewScreen(profileId: id)),
    );
  }

  void _openFeedbackHistory() {
    final id = _selectedProfile?.id;
    if (id == null) return;
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => FeedbackHistoryScreen(profileId: id)),
    );
  }

  void _openAcceptance() {
    final id = _selectedProfile?.id;
    if (id == null) return;
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => AcceptanceScreen(profileId: id)),
    );
  }

  void _showAddSheet() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.grey[900],
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox(height: 8),
            ListTile(
              leading: const Icon(Icons.camera_alt_outlined, color: Colors.white),
              title: const Text('Take photo',
                  style: TextStyle(color: Colors.white)),
              subtitle: const Text('Capture an item with the camera',
                  style: TextStyle(color: Colors.white54)),
              onTap: () {
                Navigator.pop(ctx);
                _capturePhoto();
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined,
                  color: Colors.white),
              title: const Text('Import from gallery',
                  style: TextStyle(color: Colors.white)),
              subtitle: const Text('Pick up to $kMaxUploadBatch photos at once',
                  style: TextStyle(color: Colors.white54)),
              onTap: () {
                Navigator.pop(ctx);
                _importFromGallery();
              },
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  Future<void> _capturePhoto() async {
    final id = _selectedProfile?.id;
    if (id == null) return;
    await Navigator.of(context).push<WardrobeItem>(
      MaterialPageRoute(builder: (_) => CaptureItemScreen(profileId: id)),
    );
    // The capture/editor flow adds the item to the provider on save; nothing to
    // do here beyond returning to the (already-updated) grid.
  }

  Future<void> _importFromGallery() async {
    final id = _selectedProfile?.id;
    if (id == null) return;
    await importFromGallery(context, id);
  }

  Future<void> _openItem(WardrobeItem item) async {
    await Navigator.of(context).push<WardrobeItem>(
      MaterialPageRoute(builder: (_) => ItemEditorScreen(item: item)),
    );
    // Save/delete update the provider directly, so the grid is already current.
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        title: const Text('Closet',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        actions: [
          IconButton(
            icon: const Icon(Icons.auto_awesome, color: Colors.white70),
            tooltip: 'Outfit preview',
            onPressed: _selectedProfile == null ? null : _openOutfitPreview,
          ),
          IconButton(
            icon: Badge(
              isLabelVisible: _bodyPhotoSet,
              backgroundColor: Colors.green,
              smallSize: 8,
              child:
                  const Icon(Icons.accessibility_new, color: Colors.white70),
            ),
            tooltip: _bodyPhotoSet ? 'Body photo set' : 'Body photo',
            onPressed: _selectedProfile == null ? null : _openBodyPhoto,
          ),
          PopupMenuButton<String>(
            icon: const Icon(Icons.more_vert, color: Colors.white70),
            color: Colors.grey[900],
            enabled: _selectedProfile != null,
            onSelected: (value) {
              switch (value) {
                case 'feedback':
                  _openFeedbackHistory();
                case 'acceptance':
                  _openAcceptance();
              }
            },
            itemBuilder: (_) => const [
              PopupMenuItem(
                value: 'feedback',
                child: Text('Feedback history',
                    style: TextStyle(color: Colors.white)),
              ),
              PopupMenuItem(
                value: 'acceptance',
                child: Text('Acceptance rate',
                    style: TextStyle(color: Colors.white)),
              ),
            ],
          ),
        ],
      ),
      floatingActionButton: _selectedProfile == null
          ? null
          : FloatingActionButton(
              onPressed: _showAddSheet,
              backgroundColor: Colors.white,
              foregroundColor: Colors.black,
              child: const Icon(Icons.add),
            ),
      body: _body(),
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
      return _InlineError(message: _profilesError!, onRetry: _loadProfiles);
    }
    if (_profiles.isEmpty) {
      return const Center(
        child: Text(
          'No profiles found. Create one first to build a closet.',
          textAlign: TextAlign.center,
          style: TextStyle(color: Colors.white54, fontSize: 16),
        ),
      );
    }

    return Column(
      children: [
        if (_profiles.length > 1)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
            child: _ProfileSelector(
              profiles: _profiles,
              selected: _selectedProfile,
              onChanged: _onProfileChanged,
            ),
          ),
        Expanded(child: _grid()),
      ],
    );
  }

  Widget _grid() {
    return Consumer<WardrobeProvider>(
      builder: (context, provider, _) {
        if (provider.loading && provider.items.isEmpty) {
          return const Center(
              child: CircularProgressIndicator(color: Colors.white));
        }
        if (provider.connectionError) {
          return ConnectionErrorView(onRetry: _refresh);
        }
        if (provider.error != null) {
          return _InlineError(message: provider.error!, onRetry: _refresh);
        }
        if (provider.items.isEmpty) {
          return _EmptyCloset(onAdd: _showAddSheet);
        }

        final items = provider.items;
        return DefaultTabController(
          length: _wardrobeCategories.length + 1,
          child: Column(
            children: [
              Align(
                alignment: Alignment.centerLeft,
                child: TabBar(
                  isScrollable: true,
                  tabAlignment: TabAlignment.start,
                  indicatorColor: Colors.white,
                  labelColor: Colors.white,
                  unselectedLabelColor: Colors.white54,
                  tabs: [
                    Tab(text: 'All ${items.length}'),
                    for (final c in _wardrobeCategories)
                      Tab(
                          text: '${c.label} '
                              '${items.where((i) => i.category == c.value).length}'),
                  ],
                ),
              ),
              Expanded(
                child: TabBarView(
                  children: [
                    _CategoryGrid(
                      items: items,
                      onTap: _openItem,
                      onRefresh: _refresh,
                      emptyLabel: 'No items yet',
                    ),
                    for (final c in _wardrobeCategories)
                      _CategoryGrid(
                        items: items
                            .where((i) => i.category == c.value)
                            .toList(),
                        onTap: _openItem,
                        onRefresh: _refresh,
                        emptyLabel: 'No ${c.label.toLowerCase()} yet',
                      ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

// Closet category tabs, in display order. Values are the backend enums.
const _wardrobeCategories = <({String value, String label})>[
  (value: 'top', label: 'Tops'),
  (value: 'bottom', label: 'Bottoms'),
  (value: 'outerwear', label: 'Outerwear'),
  (value: 'footwear', label: 'Footwear'),
  (value: 'accessory', label: 'Accessories'),
];

// One category's grid (or the "All" grid). Reuses _ItemTile and supports
// pull-to-refresh even when the category is empty.
class _CategoryGrid extends StatelessWidget {
  final List<WardrobeItem> items;
  final void Function(WardrobeItem) onTap;
  final Future<void> Function() onRefresh;
  final String emptyLabel;

  const _CategoryGrid({
    required this.items,
    required this.onTap,
    required this.onRefresh,
    required this.emptyLabel,
  });

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      color: Colors.white,
      backgroundColor: Colors.grey[900],
      child: items.isEmpty
          ? LayoutBuilder(
              builder: (context, constraints) => SingleChildScrollView(
                physics: const AlwaysScrollableScrollPhysics(),
                child: ConstrainedBox(
                  constraints: BoxConstraints(minHeight: constraints.maxHeight),
                  child: Padding(
                    padding: const EdgeInsets.all(32),
                    child: Center(
                      child: Text(
                        emptyLabel,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                            color: Colors.white54, fontSize: 15),
                      ),
                    ),
                  ),
                ),
              ),
            )
          : LayoutBuilder(
              builder: (context, constraints) {
                // 2 columns on phones, 3 on wider screens.
                final crossAxisCount = constraints.maxWidth >= 600 ? 3 : 2;
                return GridView.builder(
                  padding: const EdgeInsets.all(16),
                  physics: const AlwaysScrollableScrollPhysics(),
                  gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: crossAxisCount,
                    mainAxisSpacing: 12,
                    crossAxisSpacing: 12,
                    childAspectRatio: 0.78,
                  ),
                  itemCount: items.length,
                  itemBuilder: (_, i) => _ItemTile(
                    item: items[i],
                    onTap: () => onTap(items[i]),
                  ),
                );
              },
            ),
    );
  }
}

class _ProfileSelector extends StatelessWidget {
  final List<Profile> profiles;
  final Profile? selected;
  final ValueChanged<Profile?> onChanged;

  const _ProfileSelector({
    required this.profiles,
    required this.selected,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      decoration: BoxDecoration(
        color: Colors.grey[900],
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white24),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<Profile>(
          value: selected,
          dropdownColor: Colors.grey[900],
          isExpanded: true,
          icon: const Icon(Icons.arrow_drop_down, color: Colors.white),
          style: const TextStyle(color: Colors.white, fontSize: 16),
          items: profiles
              .map((p) =>
                  DropdownMenuItem<Profile>(value: p, child: Text(p.name)))
              .toList(),
          onChanged: onChanged,
        ),
      ),
    );
  }
}

class _ItemTile extends StatelessWidget {
  final WardrobeItem item;
  final VoidCallback onTap;

  const _ItemTile({required this.item, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final url = item.thumbnailUrl;
    return GestureDetector(
      onTap: onTap,
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
                  ? const _ImagePlaceholder()
                  : Image.network(
                      url,
                      fit: BoxFit.cover,
                      errorBuilder: (_, __, ___) => const _ImagePlaceholder(),
                      loadingBuilder: (ctx, child, progress) =>
                          progress == null
                              ? child
                              : const Center(
                                  child: CircularProgressIndicator(
                                      strokeWidth: 2, color: Colors.white24),
                                ),
                    ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  _ColorSwatch(hex: item.primaryColor),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      // Show the BLIP-2 detail (e.g. "top · henley") when present.
                      item.subcategory != null && item.subcategory!.isNotEmpty
                          ? '${item.category} · ${item.subcategory}'
                          : item.category,
                      style: const TextStyle(color: Colors.white, fontSize: 13),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ImagePlaceholder extends StatelessWidget {
  const _ImagePlaceholder();

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white10,
      child: const Center(
        child: Icon(Icons.checkroom, color: Colors.white24, size: 36),
      ),
    );
  }
}

// Parses a "#RRGGBB" hex into a swatch; shows a neutral dot when unparseable.
class _ColorSwatch extends StatelessWidget {
  final String? hex;
  const _ColorSwatch({required this.hex});

  @override
  Widget build(BuildContext context) {
    final color = parseHexColor(hex);
    return Container(
      width: 16,
      height: 16,
      decoration: BoxDecoration(
        color: color ?? Colors.transparent,
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white24),
      ),
      child: color == null
          ? const Icon(Icons.help_outline, size: 12, color: Colors.white24)
          : null,
    );
  }
}

// Shared hex -> Color parser used by the closet and the editor. Returns null
// for null/empty/malformed input.
Color? parseHexColor(String? hex) {
  if (hex == null) return null;
  var h = hex.trim().replaceFirst('#', '');
  if (h.length == 6) h = 'FF$h';
  if (h.length != 8) return null;
  final value = int.tryParse(h, radix: 16);
  return value == null ? null : Color(value);
}

class _EmptyCloset extends StatelessWidget {
  final VoidCallback onAdd;
  const _EmptyCloset({required this.onAdd});

  @override
  Widget build(BuildContext context) {
    // Wrapped in a scroll view so pull-to-refresh still works when empty.
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight),
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                const Icon(Icons.checkroom, size: 64, color: Colors.white24),
                const SizedBox(height: 16),
                const Text(
                  'No items yet — add clothes to build this closet',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Colors.white54, fontSize: 16),
                ),
                const SizedBox(height: 24),
                ElevatedButton.icon(
                  onPressed: onAdd,
                  icon: const Icon(Icons.add),
                  label: const Text('Add an item'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: Colors.black,
                    padding: const EdgeInsets.symmetric(
                        horizontal: 20, vertical: 14),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;
  const _InlineError({required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) {
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
