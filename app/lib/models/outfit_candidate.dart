import 'decode.dart';

// One suggested look: the item ids that make it up, the model's reasoning, and a
// confidence score.
class OutfitCandidate {
  final List<int> itemIds;
  final String reasoning;
  final double confidence;

  OutfitCandidate({
    this.itemIds = const [],
    this.reasoning = '',
    this.confidence = 0,
  });

  factory OutfitCandidate.fromJson(Map<String, dynamic> json) =>
      OutfitCandidate(
        itemIds: parseIntList(firstOf(json, ['itemIds', 'item_ids'])),
        reasoning: parseStringOrNull(json['reasoning']) ?? '',
        confidence: parseDouble(json['confidence']),
      );
}
