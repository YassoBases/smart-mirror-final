import 'dart:convert';
import '../config/api.dart';

class Profile {
  final int id;
  final int householdId;
  final String name;
  final String? email;
  final String? googleSub;
  final String? mirrorId;
  final String? faceFilename;
  final List<String>? faceFilenames;
  final String createdAt;
  final bool spotifyConnected;
  final String? spotifyDisplayName;
  final Map<String, dynamic>? widgetsConfig;

  Profile({
    required this.id,
    required this.householdId,
    required this.name,
    this.email,
    this.googleSub,
    this.mirrorId,
    this.faceFilename,
    this.faceFilenames,
    required this.createdAt,
    this.spotifyConnected = false,
    this.spotifyDisplayName,
    this.widgetsConfig,
  });

  bool get hasGmail => email != null && googleSub != null;
  bool get hasSpotify => spotifyConnected;
  bool get hasMirror => mirrorId != null && mirrorId!.isNotEmpty;
  bool get hasFace =>
      (faceFilenames != null && faceFilenames!.isNotEmpty) || faceFilename != null;

  // Derives the face image URL from the runtime base URL so re-provisioning the
  // backend (QR scan / manual entry) automatically fixes this too.
  String? get faceUrl {
    if (faceFilename == null) return null;
    final base = ApiConfig.baseUrl;
    // base ends with "/api", strip that suffix to get the server root.
    final serverRoot =
        base.endsWith('/api') ? base.substring(0, base.length - 4) : base;
    return '$serverRoot/faces/$faceFilename';
  }

  factory Profile.fromJson(Map<String, dynamic> json) => Profile(
        id: json['id'],
        householdId: json['household_id'],
        name: json['name'],
        email: json['email'],
        googleSub: json['google_sub'],
        mirrorId: json['mirror_id'],
        faceFilename: json['face_filename'],
        faceFilenames: _parseFaceFilenames(json['face_filenames']),
        createdAt: json['created_at'] ?? '',
        spotifyConnected:
            json['spotify_connected'] == true || json['spotify_connected'] == 1,
        spotifyDisplayName: json['spotify_display_name'],
        widgetsConfig: _parseWidgetsConfig(json['widgets_config']),
      );

  // face_filenames arrives as a JSON string (e.g. '["a.jpg","b.jpg"]') from SQLite.
  static List<String>? _parseFaceFilenames(dynamic raw) {
    if (raw == null) return null;
    if (raw is List) return raw.cast<String>();
    if (raw is String && raw.isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        if (decoded is List) return decoded.cast<String>();
      } catch (_) {}
    }
    return null;
  }

  // widgets_config may arrive as a JSON string (SQLite TEXT column) or as an
  // already-decoded object. Handle both, and never throw on bad data.
  static Map<String, dynamic>? _parseWidgetsConfig(dynamic raw) {
    if (raw == null) return null;
    if (raw is Map) return Map<String, dynamic>.from(raw);
    if (raw is String && raw.isNotEmpty) {
      try {
        final decoded = jsonDecode(raw);
        return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
      } catch (_) {
        return null;
      }
    }
    return null;
  }
}
