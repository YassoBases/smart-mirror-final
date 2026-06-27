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

  // Payload echoed back to render this outfit "on me": carries the description
  // (used to generate each garment's product image) plus attributes.
  Map<String, dynamic> toRenderJson() => {
        'category': category,
        if (subcategory != null) 'subcategory': subcategory,
        if (primaryColor != null) 'primaryColor': primaryColor,
        if (pattern != null) 'pattern': pattern,
        if (description != null) 'description': description,
        if (formality != null) 'formality': formality,
        if (warmth != null) 'warmth': warmth,
        'seasons': seasons,
      };
}

class GeneratedCandidate {
  final List<GeneratedItem> items;
  final String reasoning;
  final double confidence;
  // The outfit rendered onto the user's body photo ("render on me"), and the id
  // of its saved gallery entry. Null when no body photo / the render failed.
  final String? rawTryOnUrl;
  final int? generationId;

  GeneratedCandidate({
    this.items = const [],
    this.reasoning = '',
    this.confidence = 0,
    this.rawTryOnUrl,
    this.generationId,
  });

  String? get tryOnUrl => resolveServerUrl(rawTryOnUrl);

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
      rawTryOnUrl:
          parseStringOrNull(firstOf(json, ['tryOnUrl', 'try_on_url'])),
      generationId:
          parseIntOrNull(firstOf(json, ['generationId', 'generation_id'])),
    );
  }
}

// One saved entry in the generations gallery: the user wearing a generated
// outfit, with a short title and the items it was made of.
class Generation {
  final int id;
  final String kind;
  final String? title;
  final List<GeneratedItem> items;
  final String? rawImageUrl;
  final String? createdAt;

  Generation({
    required this.id,
    this.kind = 'generated_tryon',
    this.title,
    this.items = const [],
    this.rawImageUrl,
    this.createdAt,
  });

  String? get imageUrl => resolveServerUrl(rawImageUrl);

  factory Generation.fromJson(Map<String, dynamic> json) {
    final raw = firstOf(json, ['items']);
    final items = raw is List
        ? raw
            .whereType<Map>()
            .map((m) => GeneratedItem.fromJson(Map<String, dynamic>.from(m)))
            .toList()
        : <GeneratedItem>[];
    return Generation(
      id: parseIntOrNull(json['id']) ?? 0,
      kind: parseStringOrNull(json['kind']) ?? 'generated_tryon',
      title: parseStringOrNull(json['title']),
      items: items,
      rawImageUrl: parseStringOrNull(firstOf(json, ['imageUrl', 'image_url'])),
      createdAt: parseStringOrNull(firstOf(json, ['createdAt', 'created_at'])),
    );
  }
}
