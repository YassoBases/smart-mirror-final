// Ephemeral, in-memory holder for pairing data captured during first-run QR
// scan. Lives only for the duration of the sign-up flow; cleared on first use.
class PendingPairing {
  static String? _sid;
  static String? _code;

  static bool get has => _sid != null && _code != null;
  static String? get sid => _sid;
  static String? get code => _code;

  static void set(String sid, String code) {
    _sid = sid;
    _code = code;
  }

  static void clear() {
    _sid = null;
    _code = null;
  }
}
