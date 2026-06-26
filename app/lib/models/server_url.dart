import '../config/api.dart';

// Resolves an image/render URL coming from the backend into an absolute URL the
// app can load, regardless of the shape the backend sends.
//
// Mirrors Profile.faceUrl's server-root derivation (strip the trailing /api from
// ApiConfig.baseUrl) but tolerates whatever the wardrobe backend emits:
//   - null / empty            -> null
//   - already absolute (http) -> returned unchanged
//   - root-relative (/foo)    -> serverRoot + '/foo'
//   - bare filename (foo.png) -> serverRoot + '/foo.png'
//
// Because it reads ApiConfig.baseUrl every call, re-provisioning the backend
// (QR scan / manual entry) automatically fixes already-resolved URLs too.
String? resolveServerUrl(String? raw) {
  if (raw == null) return null;
  final trimmed = raw.trim();
  if (trimmed.isEmpty) return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }

  final base = ApiConfig.baseUrl;
  final serverRoot =
      base.endsWith('/api') ? base.substring(0, base.length - 4) : base;

  final path = trimmed.startsWith('/') ? trimmed : '/$trimmed';
  return '$serverRoot$path';
}
