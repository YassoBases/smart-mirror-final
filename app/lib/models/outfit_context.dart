import 'decode.dart';

// Selectable outfit occasions. "any" is the default (no preference sent).
const List<String> kOccasions = [
  'any',
  'casual',
  'smart casual',
  'business',
  'formal',
  'sport',
  'party',
];

// Weather/time/season context the backend used to suggest an outfit. Echoed back
// verbatim when sending feedback. Tolerant numeric/string parsing.
class OutfitContext {
  final double? temperature; // Celsius
  final String? weather; // e.g. "clear", "rain"
  final String? timeOfDay; // e.g. "morning", "evening"
  final String? season; // winter/spring/summer/autumn
  final String? occasion; // e.g. "casual", "formal" — user-chosen

  OutfitContext({
    this.temperature,
    this.weather,
    this.timeOfDay,
    this.season,
    this.occasion,
  });

  factory OutfitContext.fromJson(Map<String, dynamic> json) => OutfitContext(
        temperature: _temp(json['temperature']),
        weather: parseStringOrNull(json['weather']),
        timeOfDay:
            parseStringOrNull(firstOf(json, ['timeOfDay', 'time_of_day'])),
        season: parseStringOrNull(json['season']),
        occasion: parseStringOrNull(json['occasion']),
      );

  static double? _temp(dynamic raw) {
    if (raw == null) return null;
    if (raw is num) return raw.toDouble();
    if (raw is String) return double.tryParse(raw);
    return null;
  }

  // Round-trips back to the suggest response shape for the feedback payload.
  Map<String, dynamic> toJson() => {
        'temperature': temperature,
        'weather': weather,
        'timeOfDay': timeOfDay,
        'season': season,
        'occasion': occasion,
      };
}
