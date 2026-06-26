import 'dart:convert';
import 'decode.dart';
import 'outfit_context.dart';

// A past thumbs-up/down on a suggested outfit, for the feedback-history list.
class OutfitFeedback {
  final int id;
  final List<int> itemIds;
  final String rating; // "up" | "down"
  final String? reasoningShown; // the reasoning text shown when rated
  final OutfitContext? context;
  final String? createdAt;
  // Number of pieces in a GENERATED outfit (these rows carry no closet itemIds).
  final int generatedCount;

  OutfitFeedback({
    required this.id,
    this.itemIds = const [],
    this.rating = 'up',
    this.reasoningShown,
    this.context,
    this.createdAt,
    this.generatedCount = 0,
  });

  // True for feedback on an AI-generated outfit (no closet item ids).
  bool get isGenerated => itemIds.isEmpty && generatedCount > 0;

  // How many pieces the outfit had, whichever kind it was.
  int get pieceCount => itemIds.isNotEmpty ? itemIds.length : generatedCount;

  factory OutfitFeedback.fromJson(Map<String, dynamic> json) {
    final ctxRaw = firstOf(json, ['context']);
    return OutfitFeedback(
      id: parseInt(json['id']),
      itemIds: parseIntList(firstOf(json, ['itemIds', 'item_ids'])),
      rating: parseStringOrNull(json['rating']) ?? 'up',
      reasoningShown:
          parseStringOrNull(firstOf(json, ['reasoningShown', 'reasoning_shown'])),
      context: ctxRaw is Map
          ? OutfitContext.fromJson(Map<String, dynamic>.from(ctxRaw))
          : null,
      createdAt: parseStringOrNull(firstOf(json, ['createdAt', 'created_at'])),
      generatedCount: _len(firstOf(json, ['itemsSnapshot', 'items_snapshot'])),
    );
  }

  // Length of the items_snapshot array (which holds attribute objects, not ints),
  // tolerating a real List or a JSON-encoded string.
  static int _len(dynamic raw) {
    if (raw is List) return raw.length;
    if (raw is String && raw.isNotEmpty) {
      try {
        final d = jsonDecode(raw);
        if (d is List) return d.length;
      } catch (_) {}
    }
    return 0;
  }
}
