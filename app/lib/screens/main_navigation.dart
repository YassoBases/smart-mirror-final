import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/alert_provider.dart';
import '../providers/auth_provider.dart';
import '../services/pending_pairing.dart';
import 'dashboard_screen.dart';
import 'alert_screen.dart';
import 'face_setup_screen.dart';
import 'home_screen.dart';
import 'wardrobe/wardrobe_home_screen.dart';
import 'wardrobe/discover_screen.dart';

class MainNavigation extends StatefulWidget {
  const MainNavigation({super.key});

  @override
  State<MainNavigation> createState() => _MainNavigationState();
}

class _MainNavigationState extends State<MainNavigation>
    with WidgetsBindingObserver {
  int _currentIndex = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _completePendingPairing();
      // Listen for notification-tap deep-links that want to open the Alerts tab.
      context.read<AlertProvider>().addListener(_onAlertProviderChanged);
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    // Safe: provider outlives this widget so the listener must be removed.
    context.read<AlertProvider>().removeListener(_onAlertProviderChanged);
    super.dispose();
  }

  void _onAlertProviderChanged() {
    final provider = context.read<AlertProvider>();
    if (provider.pendingAlertsNavigation) {
      provider.clearNavigationRequest();
      if (mounted) setState(() => _currentIndex = 1);
    }
  }

  Future<void> _completePendingPairing() async {
    if (!PendingPairing.has) return;
    final sid  = PendingPairing.sid!;
    final code = PendingPairing.code!;
    PendingPairing.clear();
    try {
      final api      = context.read<AuthProvider>().api;
      final result   = await api.pairMirror(sid: sid, shortCode: code);
      final mirrorId = result['mirrorId'] as String?;
      if (mirrorId == null) return;
      final profiles = await api.listProfiles();
      if (profiles.isEmpty) return;
      await api.setMirrorId(profiles.first.id, mirrorId);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Mirror paired'),
            backgroundColor: Colors.green,
            duration: Duration(seconds: 3),
          ),
        );
      }
    } catch (_) {
      // Session expired or rotated — discard silently; user can pair manually.
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && mounted) {
      context.read<AlertProvider>().loadAlerts();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: IndexedStack(
          index: _currentIndex,
          children: [
            DashboardScreen(isActive: _currentIndex == 0),
            const AlertScreen(),
            FaceSetupScreen(isActive: _currentIndex == 2),
            const HomeScreen(),
            WardrobeHomeScreen(isActive: _currentIndex == 4),
            DiscoverScreen(isActive: _currentIndex == 5),
          ],
        ),
      ),
      bottomNavigationBar: Theme(
        data: Theme.of(context).copyWith(
          splashColor: Colors.transparent,
          highlightColor: Colors.transparent,
        ),
        child: BottomNavigationBar(
          type: BottomNavigationBarType.fixed,
          currentIndex: _currentIndex,
          selectedItemColor: Colors.white,
          unselectedItemColor: Colors.white54,
          backgroundColor: Colors.black,
          onTap: (index) {
            setState(() => _currentIndex = index);
            // Clear the unread badge when the user navigates to the Alerts tab.
            if (index == 1) {
              context.read<AlertProvider>().markAllRead();
            }
          },
          items: [
            const BottomNavigationBarItem(
              icon: Icon(Icons.dashboard),
              label: 'Dashboard',
            ),
            BottomNavigationBarItem(
              icon: _AlertsIcon(),
              label: 'Alerts',
            ),
            const BottomNavigationBarItem(
              icon: Icon(Icons.face),
              label: 'Face Setup',
            ),
            const BottomNavigationBarItem(
              icon: Icon(Icons.people),
              label: 'Profiles',
            ),
            const BottomNavigationBarItem(
              icon: Icon(Icons.checkroom),
              label: 'Closet',
            ),
            const BottomNavigationBarItem(
              icon: Icon(Icons.auto_awesome),
              label: 'Discover',
            ),
          ],
        ),
      ),
    );
  }
}

// Bell icon with a red badge when there are unread alerts.
class _AlertsIcon extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Consumer<AlertProvider>(
      builder: (_, provider, __) {
        final count = provider.unreadCount;
        if (count == 0) return const Icon(Icons.notifications);
        return Badge(
          label: Text(count > 99 ? '99+' : '$count'),
          backgroundColor: Colors.redAccent,
          child: const Icon(Icons.notifications),
        );
      },
    );
  }
}
