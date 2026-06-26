import 'package:shared_preferences/shared_preferences.dart';

// Backend base URL.
//
// The compiled-in default can still be overridden at build time:
//   flutter run --dart-define=API_URL=http://10.0.2.2:3000/api      (Android emulator)
//   flutter run --dart-define=API_URL=http://localhost:3000/api     (desktop/web)
//   flutter run --dart-define=API_URL=http://192.168.1.x:3000/api   (physical device)
//
// But the URL is now a *runtime* value: it can be provisioned by scanning the
// mirror's QR (see pair_mirror_screen) or typed in settings, and is persisted
// to SharedPreferences so it survives restarts. Read it via [ApiConfig.baseUrl];
// change it via [ApiConfig.setBaseUrl].
class ApiConfig {
  static const String _compiledDefault = String.fromEnvironment(
    'API_URL',
    defaultValue: 'http://192.168.1.6:3000/api',
  );

  // Key under which the runtime URL is stored in SharedPreferences.
  static const String prefsKey = 'backendBaseUrl';

  // The live base URL used by every API call. Starts as the compiled default
  // and is overwritten by [load] at startup (if a value was persisted) and by
  // [setBaseUrl] when the user re-provisions.
  static String baseUrl = _compiledDefault;

  // True once the user has provisioned a backend URL (scanned the mirror QR or
  // saved one manually) at least once. Distinguishes a genuine first run — when
  // the app can't reach any backend yet, so login/signup is pointless — from a
  // returning user. Drives first-run routing in SplashScreen.
  static bool isProvisioned = false;

  // Restores a previously persisted URL. Call once at startup before runApp.
  static Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(prefsKey);
    if (saved != null && saved.isNotEmpty) {
      baseUrl = saved;
      isProvisioned = true;
    }
  }

  // Normalizes [url], applies it as the live [baseUrl], and persists it.
  // Used by QR provisioning (Part B) and the manual-entry fallback (Part D).
  static Future<void> setBaseUrl(String url) async {
    final normalized = normalize(url);
    baseUrl = normalized;
    isProvisioned = true;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(prefsKey, normalized);
  }

  // Cleans up user/QR input into a canonical base URL:
  //   - trims surrounding whitespace
  //   - ensures an http:// scheme (defaults to http if none given)
  //   - defaults port to 3000 when no port is given (bare IP like 192.168.1.6)
  //   - strips any trailing slashes
  //   - ensures the path ends with /api
  static String normalize(String url) {
    var u = url.trim();
    if (!u.contains('://')) {
      u = 'http://$u';
    }
    // Inject :3000 when the authority has no port (e.g. typed bare IP).
    final schemeEnd = u.indexOf('://') + 3;
    final pathStart = u.indexOf('/', schemeEnd);
    final authority = pathStart < 0 ? u.substring(schemeEnd) : u.substring(schemeEnd, pathStart);
    if (!authority.contains(':')) {
      final rest = pathStart < 0 ? '' : u.substring(pathStart);
      u = '${u.substring(0, schemeEnd)}$authority:3000$rest';
    }
    // Strip trailing slashes.
    while (u.endsWith('/')) {
      u = u.substring(0, u.length - 1);
    }
    if (!u.endsWith('/api')) {
      u = '$u/api';
    }
    return u;
  }

  // Returns just the IP/hostname from the current base URL, for pre-filling
  // the manual-entry field.
  static String hostFromBaseUrl() => Uri.parse(baseUrl).host;
}
