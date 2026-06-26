import 'package:flutter_test/flutter_test.dart';
import 'package:smart_mirror_app/config/api.dart';
import 'package:smart_mirror_app/models/wardrobe_item.dart';

void main() {
  // Stub the runtime base URL so resolveServerUrl is deterministic.
  setUp(() {
    ApiConfig.baseUrl = 'http://10.0.0.5:3000/api';
  });

  // The documented contract: camelCase keys, real arrays, absolute image URLs.
  final camelJson = {
    'id': 123,
    'profileId': 4,
    'imageUrl': 'http://10.0.0.5:3000/wardrobe/4/123/nobg.png',
    'thumbnailUrl': 'http://10.0.0.5:3000/wardrobe/4/123/thumb.jpg',
    'category': 'top',
    'subcategory': 'henley',
    'primaryColor': '#7A8B9D',
    'secondaryColors': ['#FFFFFF'],
    'pattern': 'solid',
    'fabricGuess': 'cotton jersey',
    'formality': 2,
    'warmth': 2,
    'seasons': ['spring', 'autumn'],
    'tags': ['casual', 'long-sleeve'],
    'lastWornAt': null,
    'createdAt': '2024-01-01T00:00:00Z',
  };

  // The raw SQLite shape the existing backend returns: snake_case keys, arrays
  // stored as JSON-encoded TEXT, integers, and a bare-filename / root-relative
  // image path that resolveServerUrl must join onto the server root.
  final snakeJson = {
    'id': 123,
    'profile_id': 4,
    'image_url': '/wardrobe/4/123/nobg.png',
    'thumbnail_url': 'wardrobe/4/123/thumb.jpg',
    'category': 'top',
    'subcategory': 'henley',
    'primary_color': '#7A8B9D',
    'secondary_colors': '["#FFFFFF"]',
    'pattern': 'solid',
    'fabric_guess': 'cotton jersey',
    'formality': 2,
    'warmth': 2,
    'seasons': '["spring","autumn"]',
    'tags': '["casual","long-sleeve"]',
    'last_worn_at': null,
    'created_at': '2024-01-01T00:00:00Z',
  };

  test('camelCase and snake_case decode to equivalent items', () {
    final a = WardrobeItem.fromJson(camelJson);
    final b = WardrobeItem.fromJson(snakeJson);

    expect(a.id, b.id);
    expect(a.profileId, b.profileId);
    expect(a.category, b.category);
    expect(a.subcategory, b.subcategory);
    expect(a.primaryColor, b.primaryColor);
    expect(a.secondaryColors, b.secondaryColors);
    expect(a.secondaryColors, ['#FFFFFF']);
    expect(a.pattern, b.pattern);
    expect(a.fabricGuess, b.fabricGuess);
    expect(a.formality, b.formality);
    expect(a.warmth, b.warmth);
    expect(a.seasons, b.seasons);
    expect(a.seasons, ['spring', 'autumn']);
    expect(a.tags, b.tags);
    expect(a.tags, ['casual', 'long-sleeve']);

    // Both resolve to the same absolute URL regardless of input shape.
    expect(a.imageUrl, b.imageUrl);
    expect(a.imageUrl, 'http://10.0.0.5:3000/wardrobe/4/123/nobg.png');
    expect(a.thumbnailUrl, b.thumbnailUrl);
    expect(a.thumbnailUrl, 'http://10.0.0.5:3000/wardrobe/4/123/thumb.jpg');
  });

  test('integer booleans and missing fields are tolerated', () {
    final item = WardrobeItem.fromJson({
      'id': '7', // string id
      'profile_id': 4,
      // no image urls, no arrays
    });
    expect(item.id, 7);
    expect(item.secondaryColors, isEmpty);
    expect(item.seasons, isEmpty);
    expect(item.tags, isEmpty);
    expect(item.imageUrl, isNull);
    expect(item.thumbnailUrl, isNull);
    expect(item.category, 'top'); // default
  });

  test('toPatchJson emits only editable attributes', () {
    final item = WardrobeItem.fromJson(camelJson);
    final patch = item.toPatchJson();
    expect(patch.keys, containsAll(<String>{
      'category',
      'subcategory',
      'primaryColor',
      'secondaryColors',
      'pattern',
      'fabricGuess',
      'formality',
      'warmth',
      'seasons',
      'tags',
    }));
    // Non-editable identity fields must not leak into the patch.
    expect(patch.containsKey('id'), isFalse);
    expect(patch.containsKey('imageUrl'), isFalse);
    expect(patch.containsKey('createdAt'), isFalse);
  });
}
