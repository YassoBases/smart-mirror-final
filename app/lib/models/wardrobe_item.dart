import 'decode.dart';
import 'server_url.dart';

// A single garment in a profile's closet.
//
// Decodes both the documented camelCase contract and the app's raw SQLite shape
// (snake_case keys, JSON-TEXT arrays, integer booleans) — see decode.dart.
// Image URLs are stored raw and resolved on read via resolveServerUrl so that
// re-provisioning the backend automatically fixes them.
class WardrobeItem {
  final int id;
  final int profileId;
  final String? rawImageUrl;
  final String? rawThumbnailUrl;
  final String category; // top | bottom | outerwear | footwear | accessory
  final String? subcategory;
  final String? primaryColor; // hex
  final List<String> secondaryColors; // hex
  final String pattern; // solid | stripe | plaid | print | other
  final String? fabricGuess;
  final int formality; // 1..5
  final int warmth; // 1..5
  final List<String> seasons; // subset of winter/spring/summer/autumn
  final List<String> tags;
  final String? lastWornAt;
  final String? createdAt;

  WardrobeItem({
    required this.id,
    required this.profileId,
    this.rawImageUrl,
    this.rawThumbnailUrl,
    this.category = 'top',
    this.subcategory,
    this.primaryColor,
    this.secondaryColors = const [],
    this.pattern = 'solid',
    this.fabricGuess,
    this.formality = 3,
    this.warmth = 3,
    this.seasons = const [],
    this.tags = const [],
    this.lastWornAt,
    this.createdAt,
  });

  // Absolute, loadable URLs derived from the runtime server root.
  String? get imageUrl => resolveServerUrl(rawImageUrl);
  // Falls back to the full image when no thumbnail is provided.
  String? get thumbnailUrl =>
      resolveServerUrl(rawThumbnailUrl) ?? resolveServerUrl(rawImageUrl);

  factory WardrobeItem.fromJson(Map<String, dynamic> json) => WardrobeItem(
        id: parseInt(json['id']),
        profileId: parseInt(firstOf(json, ['profileId', 'profile_id'])),
        rawImageUrl:
            parseStringOrNull(firstOf(json, ['imageUrl', 'image_url'])),
        rawThumbnailUrl: parseStringOrNull(
            firstOf(json, ['thumbnailUrl', 'thumbnail_url'])),
        category: parseStringOrNull(json['category']) ?? 'top',
        subcategory: parseStringOrNull(json['subcategory']),
        primaryColor:
            parseStringOrNull(firstOf(json, ['primaryColor', 'primary_color'])),
        secondaryColors: parseStringList(
            firstOf(json, ['secondaryColors', 'secondary_colors'])),
        pattern: parseStringOrNull(json['pattern']) ?? 'solid',
        fabricGuess:
            parseStringOrNull(firstOf(json, ['fabricGuess', 'fabric_guess'])),
        formality: parseInt(json['formality'], fallback: 3),
        warmth: parseInt(json['warmth'], fallback: 3),
        seasons: parseStringList(json['seasons']),
        tags: parseStringList(json['tags']),
        lastWornAt:
            parseStringOrNull(firstOf(json, ['lastWornAt', 'last_worn_at'])),
        createdAt:
            parseStringOrNull(firstOf(json, ['createdAt', 'created_at'])),
      );

  // Emits only the editable attributes, for PATCH. Uses camelCase keys per the
  // documented contract.
  Map<String, dynamic> toPatchJson() => {
        'category': category,
        'subcategory': subcategory,
        'primaryColor': primaryColor,
        'secondaryColors': secondaryColors,
        'pattern': pattern,
        'fabricGuess': fabricGuess,
        'formality': formality,
        'warmth': warmth,
        'seasons': seasons,
        'tags': tags,
      };

  WardrobeItem copyWith({
    String? category,
    String? subcategory,
    String? primaryColor,
    List<String>? secondaryColors,
    String? pattern,
    String? fabricGuess,
    int? formality,
    int? warmth,
    List<String>? seasons,
    List<String>? tags,
  }) =>
      WardrobeItem(
        id: id,
        profileId: profileId,
        rawImageUrl: rawImageUrl,
        rawThumbnailUrl: rawThumbnailUrl,
        category: category ?? this.category,
        subcategory: subcategory ?? this.subcategory,
        primaryColor: primaryColor ?? this.primaryColor,
        secondaryColors: secondaryColors ?? this.secondaryColors,
        pattern: pattern ?? this.pattern,
        fabricGuess: fabricGuess ?? this.fabricGuess,
        formality: formality ?? this.formality,
        warmth: warmth ?? this.warmth,
        seasons: seasons ?? this.seasons,
        tags: tags ?? this.tags,
        lastWornAt: lastWornAt,
        createdAt: createdAt,
      );
}
