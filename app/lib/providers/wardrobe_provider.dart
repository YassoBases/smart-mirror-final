import 'package:flutter/foundation.dart';
import '../models/wardrobe_item.dart';
import '../services/api_service.dart';

// Holds the closet for the currently selected profile. Structurally a
// ChangeNotifier like AlertProvider, but its load/refresh follows the API-list
// pattern used in HomeScreen (call api.xxx, track loading/error). It holds no
// token: every method takes the authenticated ApiService from
// context.read<AuthProvider>().api at the call site.
class WardrobeProvider extends ChangeNotifier {
  int? _profileId;
  List<WardrobeItem> _items = [];
  bool _loading = false;
  String? _error; // ApiException message
  bool _connectionError = false; // non-ApiException (connectivity) failure

  int? get profileId => _profileId;
  List<WardrobeItem> get items => List.unmodifiable(_items);
  bool get loading => _loading;
  String? get error => _error;
  bool get connectionError => _connectionError;

  // Switches the active profile. Clears items if the profile actually changed so
  // the grid never shows a stale closet while the new one loads.
  void selectProfile(int id) {
    if (_profileId == id) return;
    _profileId = id;
    _items = [];
    _error = null;
    _connectionError = false;
    notifyListeners();
  }

  Future<void> load(ApiService api, {String? category, String? season}) async {
    final id = _profileId;
    if (id == null) return;
    _loading = true;
    _error = null;
    _connectionError = false;
    notifyListeners();
    try {
      final items =
          await api.listWardrobeItems(id, category: category, season: season);
      _items = items;
    } on ApiException catch (e) {
      _error = e.message;
    } catch (_) {
      _connectionError = true;
    } finally {
      _loading = false;
      notifyListeners();
    }
  }

  // Local mutations so the grid refreshes after capture/edit/delete without a
  // full reload.
  void addItem(WardrobeItem item) {
    _items = [item, ..._items];
    notifyListeners();
  }

  void replaceItem(WardrobeItem item) {
    _items = _items.map((e) => e.id == item.id ? item : e).toList();
    notifyListeners();
  }

  void removeItem(int id) {
    _items = _items.where((e) => e.id != id).toList();
    notifyListeners();
  }
}
