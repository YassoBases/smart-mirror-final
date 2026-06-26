import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/wardrobe_item.dart';
import '../../providers/auth_provider.dart';
import '../../providers/wardrobe_provider.dart';
import '../../services/api_service.dart';
import 'wardrobe_home_screen.dart' show parseHexColor;

// Editable form for one item. Used both to confirm attributes right after
// capture (isNew = true) and to edit an existing item from the grid
// (isNew = false). Save sends only the editable attributes via toPatchJson and
// updates the WardrobeProvider so the grid reflects the change immediately.
class ItemEditorScreen extends StatefulWidget {
  final WardrobeItem item;
  final bool isNew;
  const ItemEditorScreen({super.key, required this.item, this.isNew = false});

  @override
  State<ItemEditorScreen> createState() => _ItemEditorScreenState();
}

const _categories = ['top', 'bottom', 'outerwear', 'footwear', 'accessory'];
const _patterns = ['solid', 'stripe', 'plaid', 'print', 'other'];
const _seasons = ['winter', 'spring', 'summer', 'autumn'];

// A small palette for quick primary/secondary colour selection. The hex field
// covers anything not in the palette.
const _palette = [
  '#000000', '#FFFFFF', '#7A8B9D', '#1E3A5F', '#3E4C59',
  '#8B0000', '#B22222', '#C19A6B', '#556B2F', '#2E8B57',
  '#F5DEB3', '#4B3621', '#D2B48C', '#708090', '#FFD700',
];

class _ItemEditorScreenState extends State<ItemEditorScreen> {
  late String _category;
  late TextEditingController _subcategory;
  late String _pattern;
  late String? _primaryColor;
  late List<String> _secondaryColors;
  late TextEditingController _fabric;
  late int _formality;
  late int _warmth;
  late List<String> _seasonsSel;
  late List<String> _tags;

  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final it = widget.item;
    _category = _categories.contains(it.category) ? it.category : 'top';
    _subcategory = TextEditingController(text: it.subcategory ?? '');
    _pattern = _patterns.contains(it.pattern) ? it.pattern : 'solid';
    _primaryColor = it.primaryColor;
    _secondaryColors = List.of(it.secondaryColors);
    _fabric = TextEditingController(text: it.fabricGuess ?? '');
    _formality = it.formality.clamp(1, 5);
    _warmth = it.warmth.clamp(1, 5);
    _seasonsSel = it.seasons.where(_seasons.contains).toList();
    _tags = List.of(it.tags);
  }

  @override
  void dispose() {
    _subcategory.dispose();
    _fabric.dispose();
    super.dispose();
  }

  ApiService get _api => context.read<AuthProvider>().api;

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    final edited = widget.item.copyWith(
      category: _category,
      subcategory: _subcategory.text.trim().isEmpty
          ? null
          : _subcategory.text.trim(),
      primaryColor: _primaryColor,
      secondaryColors: _secondaryColors,
      pattern: _pattern,
      fabricGuess:
          _fabric.text.trim().isEmpty ? null : _fabric.text.trim(),
      formality: _formality,
      warmth: _warmth,
      seasons: _seasonsSel,
      tags: _tags,
    );
    try {
      final saved = await _api.updateWardrobeItem(
        widget.item.profileId,
        widget.item.id,
        edited.toPatchJson(),
      );
      if (!mounted) return;
      final provider = context.read<WardrobeProvider>();
      if (widget.isNew) {
        provider.addItem(saved);
      } else {
        provider.replaceItem(saved);
      }
      if (mounted) Navigator.of(context).pop(saved);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Connection error — could not save changes');
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _delete() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Colors.grey[900],
        title: const Text('Delete item', style: TextStyle(color: Colors.white)),
        content: const Text(
          'Remove this item from the closet? This cannot be undone.',
          style: TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel', style: TextStyle(color: Colors.white54)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child:
                const Text('Delete', style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
    );
    if (confirm != true) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await _api.deleteWardrobeItem(widget.item.profileId, widget.item.id);
      if (mounted) {
        context.read<WardrobeProvider>().removeItem(widget.item.id);
        Navigator.of(context).pop();
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Connection error — could not delete item');
      }
    } finally {
      if (mounted) setState(() => _saving = false);
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
        title: Text(widget.isNew ? 'Confirm item' : 'Edit item',
            style: const TextStyle(
                color: Colors.white, fontWeight: FontWeight.bold)),
        actions: [
          if (!widget.isNew)
            IconButton(
              icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
              tooltip: 'Delete item',
              onPressed: _saving ? null : _delete,
            ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          _itemImage(),
          const SizedBox(height: 20),
          _label('Category'),
          _dropdown(_category, _categories, (v) => setState(() => _category = v)),
          const SizedBox(height: 16),
          _label('Subcategory'),
          _textField(_subcategory, hint: 'e.g. henley, chinos'),
          const SizedBox(height: 16),
          _label('Pattern'),
          _dropdown(_pattern, _patterns, (v) => setState(() => _pattern = v)),
          const SizedBox(height: 16),
          _label('Primary colour'),
          _primaryColorEditor(),
          const SizedBox(height: 16),
          _label('Secondary colours'),
          _secondaryColorEditor(),
          const SizedBox(height: 16),
          _label('Formality'),
          _slider(_formality, (v) => setState(() => _formality = v)),
          const SizedBox(height: 8),
          _label('Warmth'),
          _slider(_warmth, (v) => setState(() => _warmth = v)),
          const SizedBox(height: 16),
          _label('Seasons'),
          _seasonChips(),
          const SizedBox(height: 16),
          _label('Tags'),
          _tagEditor(),
          if (_error != null) ...[
            const SizedBox(height: 16),
            Text(_error!,
                style: const TextStyle(color: Colors.redAccent),
                textAlign: TextAlign.center),
          ],
          const SizedBox(height: 24),
          SizedBox(
            width: double.infinity,
            height: 50,
            child: ElevatedButton(
              onPressed: _saving ? null : _save,
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.white,
                foregroundColor: Colors.black,
                shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12)),
              ),
              child: _saving
                  ? const SizedBox(
                      width: 20,
                      height: 20,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.black))
                  : Text(widget.isNew ? 'Save to closet' : 'Save changes',
                      style: const TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w600)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _itemImage() {
    final url = widget.item.imageUrl;
    return ClipRRect(
      borderRadius: BorderRadius.circular(16),
      child: AspectRatio(
        aspectRatio: 1,
        child: url == null
            ? Container(
                color: Colors.white10,
                child: const Icon(Icons.checkroom,
                    color: Colors.white24, size: 48),
              )
            : Image.network(
                url,
                fit: BoxFit.cover,
                errorBuilder: (_, __, ___) => Container(
                  color: Colors.white10,
                  child: const Icon(Icons.broken_image,
                      color: Colors.white24, size: 48),
                ),
              ),
      ),
    );
  }

  Widget _label(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 8),
        child: Text(text,
            style: const TextStyle(
                color: Colors.white70,
                fontSize: 14,
                fontWeight: FontWeight.w600)),
      );

  Widget _dropdown(
      String value, List<String> options, ValueChanged<String> onChanged) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: Colors.grey[900],
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Colors.white24),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: value,
          dropdownColor: Colors.grey[900],
          isExpanded: true,
          icon: const Icon(Icons.arrow_drop_down, color: Colors.white),
          style: const TextStyle(color: Colors.white, fontSize: 16),
          items: options
              .map((o) => DropdownMenuItem(value: o, child: Text(o)))
              .toList(),
          onChanged: (v) {
            if (v != null) onChanged(v);
          },
        ),
      ),
    );
  }

  Widget _textField(TextEditingController c, {String? hint}) {
    return TextField(
      controller: c,
      style: const TextStyle(color: Colors.white),
      decoration: InputDecoration(
        hintText: hint,
        hintStyle: const TextStyle(color: Colors.white24),
        enabledBorder: const OutlineInputBorder(
            borderSide: BorderSide(color: Colors.white24)),
        focusedBorder: const OutlineInputBorder(
            borderSide: BorderSide(color: Colors.white)),
      ),
    );
  }

  Widget _slider(int value, ValueChanged<int> onChanged) {
    return Row(
      children: [
        Expanded(
          child: Slider(
            value: value.toDouble(),
            min: 1,
            max: 5,
            divisions: 4,
            label: '$value',
            activeColor: Colors.white,
            inactiveColor: Colors.white24,
            onChanged: (v) => onChanged(v.round()),
          ),
        ),
        SizedBox(
          width: 24,
          child: Text('$value',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white)),
        ),
      ],
    );
  }

  Widget _primaryColorEditor() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final hex in _palette)
              _swatchButton(
                hex: hex,
                selected: _sameColor(_primaryColor, hex),
                onTap: () => setState(() => _primaryColor = hex),
              ),
          ],
        ),
        const SizedBox(height: 12),
        _HexField(
          initial: _primaryColor,
          onChanged: (hex) => setState(() => _primaryColor = hex),
        ),
      ],
    );
  }

  Widget _secondaryColorEditor() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_secondaryColors.isNotEmpty)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final hex in _secondaryColors)
                Chip(
                  backgroundColor: Colors.grey[850],
                  avatar: Container(
                    decoration: BoxDecoration(
                      color: parseHexColor(hex) ?? Colors.transparent,
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white24),
                    ),
                  ),
                  label: Text(hex,
                      style: const TextStyle(
                          color: Colors.white, fontSize: 12)),
                  deleteIconColor: Colors.white54,
                  onDeleted: () =>
                      setState(() => _secondaryColors.remove(hex)),
                ),
            ],
          ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final hex in _palette)
              _swatchButton(
                hex: hex,
                selected: _secondaryColors.any((c) => _sameColor(c, hex)),
                onTap: () => setState(() {
                  if (_secondaryColors.any((c) => _sameColor(c, hex))) {
                    _secondaryColors
                        .removeWhere((c) => _sameColor(c, hex));
                  } else {
                    _secondaryColors.add(hex);
                  }
                }),
              ),
          ],
        ),
      ],
    );
  }

  Widget _swatchButton(
      {required String hex,
      required bool selected,
      required VoidCallback onTap}) {
    final color = parseHexColor(hex);
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: color ?? Colors.transparent,
          shape: BoxShape.circle,
          border: Border.all(
            color: selected ? Colors.white : Colors.white24,
            width: selected ? 3 : 1,
          ),
        ),
      ),
    );
  }

  Widget _seasonChips() {
    return Wrap(
      spacing: 8,
      children: [
        for (final s in _seasons)
          FilterChip(
            label: Text(s),
            selected: _seasonsSel.contains(s),
            backgroundColor: Colors.grey[900],
            selectedColor: Colors.white24,
            checkmarkColor: Colors.white,
            labelStyle: const TextStyle(color: Colors.white),
            side: const BorderSide(color: Colors.white24),
            onSelected: (sel) => setState(() {
              if (sel) {
                _seasonsSel.add(s);
              } else {
                _seasonsSel.remove(s);
              }
            }),
          ),
      ],
    );
  }

  Widget _tagEditor() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_tags.isNotEmpty)
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              for (final t in _tags)
                Chip(
                  backgroundColor: Colors.grey[850],
                  label: Text(t,
                      style: const TextStyle(color: Colors.white, fontSize: 12)),
                  deleteIconColor: Colors.white54,
                  onDeleted: () => setState(() => _tags.remove(t)),
                ),
            ],
          ),
        const SizedBox(height: 8),
        _TagInput(
          onAdd: (tag) => setState(() {
            if (!_tags.contains(tag)) _tags.add(tag);
          }),
        ),
      ],
    );
  }

  bool _sameColor(String? a, String b) {
    if (a == null) return false;
    return a.replaceFirst('#', '').toUpperCase() ==
        b.replaceFirst('#', '').toUpperCase();
  }
}

// Editable hex field with a live preview swatch.
class _HexField extends StatefulWidget {
  final String? initial;
  final ValueChanged<String?> onChanged;
  const _HexField({required this.initial, required this.onChanged});

  @override
  State<_HexField> createState() => _HexFieldState();
}

class _HexFieldState extends State<_HexField> {
  late TextEditingController _c;

  @override
  void initState() {
    super.initState();
    _c = TextEditingController(text: widget.initial ?? '');
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Container(
          width: 32,
          height: 32,
          decoration: BoxDecoration(
            color: parseHexColor(_c.text) ?? Colors.transparent,
            shape: BoxShape.circle,
            border: Border.all(color: Colors.white24),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: TextField(
            controller: _c,
            style: const TextStyle(color: Colors.white),
            decoration: const InputDecoration(
              hintText: '#RRGGBB',
              hintStyle: TextStyle(color: Colors.white24),
              enabledBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: Colors.white24)),
              focusedBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: Colors.white)),
            ),
            onChanged: (v) {
              setState(() {}); // refresh preview swatch
              final hex = v.trim();
              widget.onChanged(hex.isEmpty ? null : hex);
            },
          ),
        ),
      ],
    );
  }
}

// Single-line tag entry: type and submit to add.
class _TagInput extends StatefulWidget {
  final ValueChanged<String> onAdd;
  const _TagInput({required this.onAdd});

  @override
  State<_TagInput> createState() => _TagInputState();
}

class _TagInputState extends State<_TagInput> {
  final _c = TextEditingController();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  void _submit() {
    final t = _c.text.trim();
    if (t.isEmpty) return;
    widget.onAdd(t);
    _c.clear();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: TextField(
            controller: _c,
            style: const TextStyle(color: Colors.white),
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _submit(),
            decoration: const InputDecoration(
              hintText: 'Add a tag',
              hintStyle: TextStyle(color: Colors.white24),
              enabledBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: Colors.white24)),
              focusedBorder: OutlineInputBorder(
                  borderSide: BorderSide(color: Colors.white)),
            ),
          ),
        ),
        IconButton(
          icon: const Icon(Icons.add, color: Colors.white),
          onPressed: _submit,
        ),
      ],
    );
  }
}
