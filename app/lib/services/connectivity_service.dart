import 'package:http/http.dart' as http;
import '../config/api.dart';

class ConnectivityService {
  static String healthUrl([String? base]) {
    final b = base ?? ApiConfig.baseUrl;
    final root = b.endsWith('/api') ? b.substring(0, b.length - 4) : b;
    return '$root/health';
  }

  static Future<bool> isBackendReachable({
    Duration timeout = const Duration(seconds: 5),
  }) async {
    try {
      final res = await http.get(Uri.parse(healthUrl())).timeout(timeout);
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch (_) {
      return false;
    }
  }
}
