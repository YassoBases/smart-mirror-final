import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/auth_provider.dart';
import '../models/profile.dart';
import '../services/api_service.dart';
import '../widgets/connection_error_view.dart';
import 'app_settings_screen.dart';

class DashboardScreen extends StatefulWidget {
  final bool isActive;
  const DashboardScreen({super.key, this.isActive = true});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  List<Profile> _profiles = [];
  Profile? _selectedProfile;
  bool _isLoading = true;
  String? _error;
  bool _isConnectionError = false;

  // Local state for toggles, with default fallbacks
  late Map<String, bool> _widgets;

  @override
  void initState() {
    super.initState();
    _resetWidgetsToDefault();
    _loadProfiles();
  }

  @override
  void didUpdateWidget(DashboardScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The parent keeps every tab alive in an IndexedStack, so initState only
    // runs once. Re-fetch when this tab becomes visible again so profiles
    // added/removed on the Profiles tab show up here too.
    if (widget.isActive && !oldWidget.isActive) {
      _loadProfiles();
    }
  }

  void _resetWidgetsToDefault() {
    _widgets = {
      'time_calendar': true, // Merged Clock and Calendar
      'weather': true,
      'news': true,
      'gmail': false,
      'spotify': false,
      'gesture': true,
    };
  }

  void _applyProfileWidgets(Profile profile) {
    _resetWidgetsToDefault();
    if (profile.widgetsConfig != null) {
      profile.widgetsConfig!.forEach((key, value) {
        if (_widgets.containsKey(key)) {
          // Coerce defensively — backend may send bool, int (1/0), or string.
          _widgets[key] = value == true || value == 1 || value == '1';
        }
      });
    }
  }

  Future<void> _loadProfiles() async {
    if (mounted) {
      setState(() {
        _isLoading = true;
        _error = null;
        _isConnectionError = false;
      });
    }
    try {
      final api = context.read<AuthProvider>().api;
      final profiles = await api.listProfiles();
      if (mounted) {
        setState(() {
          _profiles = profiles;
          if (_profiles.isNotEmpty) {
            // Keep the user's current selection across reloads if it still
            // exists; otherwise fall back to the first profile.
            final prevId = _selectedProfile?.id;
            _selectedProfile = _profiles.firstWhere(
              (p) => p.id == prevId,
              orElse: () => _profiles.first,
            );
            _applyProfileWidgets(_selectedProfile!);
          } else {
            _selectedProfile = null;
          }
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          if (e is ApiException) {
            _error = e.message;
          } else {
            _isConnectionError = true;
          }
          _isLoading = false;
        });
      }
    }
  }

  Future<void> _toggleWidget(String key, bool value) async {
    if (_selectedProfile == null) return;

    // 1. Optimistic UI update (feels instant)
    setState(() {
      _widgets[key] = value;
    });

    // 2. Save to backend
    try {
      final api = context.read<AuthProvider>().api;
      await api.updateWidgets(_selectedProfile!.id, _widgets);
    } catch (e) {
      // Revert if the API call fails
      if (mounted) {
        setState(() {
          _widgets[key] = !value;
        });
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text('Failed to save preference: $e'),
              backgroundColor: Colors.red),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Center(
          child: CircularProgressIndicator(color: Colors.white));
    }

    if (_isConnectionError) {
      return ConnectionErrorView(onRetry: _loadProfiles);
    }

    if (_error != null) {
      return Center(
          child:
              Text(_error!, style: const TextStyle(color: Colors.redAccent)));
    }

    if (_profiles.isEmpty) {
      return const Center(
          child: Text('No profiles found. Please create one to manage widgets.',
              style: TextStyle(color: Colors.white54)));
    }

    return ListView(
      padding: const EdgeInsets.all(16.0),
      children: [
        const Text(
          'Active Widgets',
          style: TextStyle(
              fontSize: 24, fontWeight: FontWeight.bold, color: Colors.white),
        ),
        const SizedBox(height: 8),
        const Text(
          'Toggle what appears on the Smart Mirror.',
          style: TextStyle(color: Colors.white54),
        ),
        const SizedBox(height: 24),

        // Profile Selector
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          decoration: BoxDecoration(
            color: Colors.grey[900],
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Colors.white24),
          ),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<Profile>(
              value: _selectedProfile,
              dropdownColor: Colors.grey[900],
              isExpanded: true,
              icon: const Icon(Icons.arrow_drop_down, color: Colors.white),
              style: const TextStyle(color: Colors.white, fontSize: 16),
              items: _profiles.map((profile) {
                return DropdownMenuItem<Profile>(
                  value: profile,
                  child: Text(profile.name),
                );
              }).toList(),
              onChanged: (Profile? newValue) {
                if (newValue != null) {
                  setState(() {
                    _selectedProfile = newValue;
                    _applyProfileWidgets(newValue);
                  });
                }
              },
            ),
          ),
        ),
        const SizedBox(height: 24),

        // Time & Calendar
        Card(
          color: Colors.grey[900],
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          child: SwitchListTile(
            title: const Text('Time & Calendar',
                style: TextStyle(color: Colors.white)),
            subtitle: const Text(
                'Display the current time, date, and upcoming events.',
                style: TextStyle(color: Colors.white54)),
            value: _widgets['time_calendar'] ?? true, // Safe fallback
            activeThumbColor: Colors.blueAccent,
            onChanged: (val) => _toggleWidget('time_calendar', val),
          ),
        ),
        const SizedBox(height: 12),

        // Weather
        Card(
          color: Colors.grey[900],
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          child: SwitchListTile(
            title: const Text('Weather', style: TextStyle(color: Colors.white)),
            subtitle: const Text('Show local temperature and forecast.',
                style: TextStyle(color: Colors.white54)),
            value: _widgets['weather']!,
            activeThumbColor: Colors.blueAccent,
            onChanged: (val) => _toggleWidget('weather', val),
          ),
        ),
        const SizedBox(height: 12),

        // News
        Card(
          color: Colors.grey[900],
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          child: SwitchListTile(
            title: const Text('News', style: TextStyle(color: Colors.white)),
            subtitle: const Text('Display top headlines.',
                style: TextStyle(color: Colors.white54)),
            value: _widgets['news']!,
            activeThumbColor: Colors.blueAccent,
            onChanged: (val) => _toggleWidget('news', val),
          ),
        ),
        const SizedBox(height: 12),

        // Gmail
        Card(
          color: Colors.grey[900],
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          child: SwitchListTile(
            title: const Text('Gmail', style: TextStyle(color: Colors.white)),
            subtitle: const Text('Show unread emails preview.',
                style: TextStyle(color: Colors.white54)),
            value: _widgets['gmail']!,
            activeThumbColor: Colors.blueAccent,
            onChanged: (val) => _toggleWidget('gmail', val),
          ),
        ),
        const SizedBox(height: 12),

        // Spotify
        Card(
          color: Colors.grey[900],
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          child: SwitchListTile(
            title: const Text('Spotify', style: TextStyle(color: Colors.white)),
            subtitle: const Text('Display currently playing track.',
                style: TextStyle(color: Colors.white54)),
            value: _widgets['spotify']!,
            activeThumbColor: Colors.blueAccent,
            onChanged: (val) => _toggleWidget('spotify', val),
          ),
        ),
        const SizedBox(height: 12),

        // Gesture Recognition
        Card(
          color: Colors.grey[900],
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          child: SwitchListTile(
            title: const Text('Gesture Recognition',
                style: TextStyle(color: Colors.white)),
            subtitle: const Text('When on, widgets can be moved with hand gestures. When off, widgets stay locked in place.',
                style: TextStyle(color: Colors.white54)),
            value: _widgets['gesture']!,
            activeThumbColor: Colors.blueAccent,
            onChanged: (val) => _toggleWidget('gesture', val),
          ),
        ),
        const SizedBox(height: 24),

        // AI Assistant
        const Text(
          'AI',
          style: TextStyle(
              fontSize: 18, fontWeight: FontWeight.bold, color: Colors.white),
        ),
        const SizedBox(height: 12),
        GestureDetector(
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => const AppSettingsScreen(),
            ),
          ),
          child: Opacity(
            opacity: 1.0,
            child: Card(
            color: Colors.grey[900],
            shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(12)),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      color: Colors.white10,
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Icon(Icons.auto_awesome,
                        color: Colors.white70, size: 22),
                  ),
                  const SizedBox(width: 14),
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Settings',
                            style: TextStyle(
                                color: Colors.white,
                                fontSize: 15,
                                fontWeight: FontWeight.w600)),
                        SizedBox(height: 3),
                        Text(
                          'OpenAI & Replicate keys, AI models — shared with the mirror.',
                          style:
                              TextStyle(color: Colors.white54, fontSize: 13),
                        ),
                      ],
                    ),
                  ),
                  const Icon(Icons.chevron_right, color: Colors.white24),
                ],
              ),
            ),
          ),
          ),
        ),
      ],
    );
  }
}
