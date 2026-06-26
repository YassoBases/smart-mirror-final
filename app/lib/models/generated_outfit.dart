import 'decode.dart';
import 'server_url.dart';

// One AI-generated garment idea (not from the closet). Carries attributes, a
// generated preview image, and a shopping search link. Tolerant decode per the
// app conventions; imageUrl resolved via resolveServerUrl.
class GeneratedItem {
  final String category;
  final String? subcategory;
  final String? primaryColor; // hex
  final String? pattern;
  final int? formality; // 1..5
  final int? warmth; // 1..5
  final List<String> seasons;
  final String? description;
  final String? rawImageUrl;
  final String? searchUrl;

  GeneratedItem({
    this.category = 'top',
    this.subcategory,
    this.primaryColor,
    this.pattern,
    this.formality,
    this.warmth,
    this.seasons = const [],
    this.description,
    this.rawImageUrl,
    this.searchUrl,
  });

  String? get imageUrl => resolveServerUrl(rawImageUrl);

  factory GeneratedItem.fromJson(Map<String, dynamic> json) => GeneratedItem(
        category: parseStringOrNull(json['category']) ?? 'top',
        subcategory: parseStringOrNull(json['subcategory']),
        primaryColor:
            parseStringOrNull(firstOf(json, ['primaryColor', 'primary_color'])),
        pattern: parseStringOrNull(json['pattern']),
        formality: parseIntOrNull(json['formality']),
        warmth: parseIntOrNull(json['warmth']),
        seasons: parseStringList(json['seasons']),
        description: parseStringOrNull(json['description']),
        rawImageUrl:
            parseStringOrNull(firstOf(json, ['imageUrl', 'image_url'])),
        searchUrl: parseStringOrNull(firstOf(json, ['searchUrl', 'search_url'])),
      );

  // Attribute payload echoed back with feedback so the preference model learns
  // the user's taste from generated outfits (same shape the ranker scores).
  Map<String, dynamic> toFeedbackJson() => {
        'category': category,
        if (subcategory != null) 'subcategory': subcategory,
        if (primaryColor != null) 'primaryColor': primaryColor,
        if (pattern != null) 'pattern': pattern,
        if (formality != null) 'formality': formality,
        if (warmth != null) 'warmth': warmth,
        'seasons': seasons,
      };
}

class GeneratedCandidate {
  final List<GeneratedItem> items;
  final String reasoning;
  final double confidence;

  GeneratedCandidate({
    this.items = const [],
    this.reasoning = '',
    this.confidence = 0,
  });

  factory GeneratedCandidate.fromJson(Map<String, dynamic> json) {
    final raw = firstOf(json, ['items']);
    final items = raw is List
        ? raw
            .whereType<Map>()
            .map((m) => GeneratedItem.fromJson(Map<String, dynamic>.from(m)))
            .toList()
        : <GeneratedItem>[];
    return GeneratedCandidate(
      items: items,
      reasoning: parseStringOrNull(json['reasoning']) ?? '',
      confidence: parseDouble(json['confidence']),
    );
  }
}
