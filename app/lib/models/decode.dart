import 'dart:convert';

// Tolerant decode helpers shared by the wardrobe/outfit models.
//
// The wardrobe backend may serialize either camelCase JSON with real arrays
// (the documented contract) or raw SQLite rows (snake_case, arrays stored as
// JSON-encoded TEXT, integer booleans). These helpers absorb both shapes so
// every fromJson stays small and never throws on unexpected data.

// Returns the first non-null value among [keys], so callers can accept both
// key cases, e.g. firstOf(json, ['imageUrl', 'image_url']).
dynamic firstOf(Map<String, dynamic> json, List<String> keys) {
  for (final k in keys) {
    final v = json[k];
    if (v != null) return v;
  }
  return null;
}

// A list of strings that may arrive as a real List or as a JSON-encoded String
// (SQLite TEXT). Mirrors Profile._parseFaceFilenames. Never throws.
List<String> parseStringList(dynamic raw) {
  if (raw == null) return const [];
  if (raw is List) return raw.map((e) => e.toString()).toList();
  if (raw is String && raw.isNotEmpty) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) return decoded.map((e) => e.toString()).toList();
    } catch (_) {}
  }
  return const [];
}

// A list of ints that may arrive as a real List or a JSON-encoded String.
List<int> parseIntList(dynamic raw) {
  Iterable? items;
  if (raw is List) {
    items = raw;
  } else if (raw is String && raw.isNotEmpty) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is List) items = decoded;
    } catch (_) {}
  }
  if (items == null) return const [];
  return items
      .map((e) => e is int ? e : int.tryParse(e.toString()))
      .whereType<int>()
      .toList();
}

int parseInt(dynamic raw, {int fallback = 0}) {
  if (raw is int) return raw;
  if (raw is num) return raw.toInt();
  if (raw is String) return int.tryParse(raw) ?? fallback;
  return fallback;
}

int? parseIntOrNull(dynamic raw) {
  if (raw is int) return raw;
  if (raw is num) return raw.toInt();
  if (raw is String) return int.tryParse(raw);
  return null;
}

double parseDouble(dynamic raw, {double fallback = 0}) {
  if (raw is num) return raw.toDouble();
  if (raw is String) return double.tryParse(raw) ?? fallback;
  return fallback;
}

bool parseBool(dynamic raw) => raw == true || raw == 1 || raw == '1';

String? parseStringOrNull(dynamic raw) {
  if (raw == null) return null;
  final s = raw.toString();
  return s.isEmpty ? null : s;
}
