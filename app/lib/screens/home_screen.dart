import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/profile.dart';
import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import '../widgets/connection_error_view.dart';
import 'add_profile_screen.dart';
import 'face_setup_screen.dart';
import 'pair_mirror_screen.dart';
import 'profile_screen.dart';
import 'welcome_screen.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<Profile> _profiles = [];
  bool _loading = true;
  String? _error;
  bool _isConnectionError = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
      _isConnectionError = false;
    });
    try {
      final profiles = await context.read<AuthProvider>().api.listProfiles();
      if (mounted) setState(() => _profiles = profiles);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _isConnectionError = true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _logout() async {
    await context.read<AuthProvider>().logout();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const WelcomeScreen()),
      (_) => false,
    );
  }

  Future<void> _pairMirror() async {
    final mirrorId = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const PairMirrorScreen()),
    );
    if (mirrorId == null || !mounted) return;

    // Ask the user which profile to link the mirror to
    if (_profiles.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Create a profile first, then pair the mirror.')),
      );
      return;
    }

    if (_profiles.length == 1) {
      // Auto-link the only profile
      await _linkMirrorToProfile(_profiles.first.id, mirrorId);
      return;
    }

    // Multiple profiles — show a picker
    if (!mounted) return;
    final chosen = await showDialog<int>(
      context: context,
      builder: (ctx) => SimpleDialog(
        backgroundColor: Colors.grey[900],
        title: const Text('Link mirror to which profile?',
            style: TextStyle(color: Colors.white, fontSize: 16)),
        children: [
          for (final p in _profiles)
            SimpleDialogOption(
              onPressed: () => Navigator.of(ctx).pop(p.id),
              child: Text(p.name,
                  style: const TextStyle(color: Colors.white70)),
            ),
        ],
      ),
    );
    if (chosen == null || !mounted) return;
    await _linkMirrorToProfile(chosen, mirrorId);
  }

  Future<void> _linkMirrorToProfile(int profileId, String mirrorId) async {
    try {
      await context.read<AuthProvider>().api.setMirrorId(profileId, mirrorId);
      try {
        await context.read<AuthProvider>().api.setActiveUser(mirrorId: mirrorId, profileId: profileId);
      } catch (_) {}
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Mirror linked! It will recognise this profile once a face is registered.')),
        );
      }
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to link mirror. Try again from the profile screen.')),
        );
      }
    }
    _load();
  }

  void _openProfile(Profile profile) async {
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ProfileScreen(profile: profile),
    ));
    _load(); // refresh after returning — Gmail may have been connected
  }

  void _addProfile() async {
    final newProfile = await Navigator.of(context).push<Profile>(MaterialPageRoute(
      builder: (_) => const AddProfileScreen(),
    ));
    if (newProfile == null || !mounted) return;

    // Auto-link to the mirror that is already paired in this household.
    final mirrorId =
        _profiles.where((p) => p.mirrorId != null).firstOrNull?.mirrorId;
    if (mirrorId != null) {
      try {
        await context.read<AuthProvider>().api.setMirrorId(newProfile.id, mirrorId);
        await context.read<AuthProvider>().api.setActiveUser(mirrorId: mirrorId, profileId: newProfile.id);
      } catch (_) {
        // Mirror link failed silently; user can link from the profile screen.
      }
    }

    if (!mounted) return;
    // Guide the user straight into face capture for the new profile.
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => Scaffold(
        backgroundColor: Colors.black,
        appBar: AppBar(
          backgroundColor: Colors.black,
          iconTheme: const IconThemeData(color: Colors.white),
          title: const Text('Register Face',
              style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
          elevation: 0,
        ),
        body: SafeArea(
          child: FaceSetupScreen(isActive: true, initialProfile: newProfile),
        ),
      ),
    ));
    _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        title: const Text('Profiles',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        actions: [
          IconButton(
            icon: const Icon(Icons.qr_code_scanner, color: Colors.white70),
            onPressed: _pairMirror,
            tooltip: 'Pair Mirror',
          ),
          IconButton(
            icon: const Icon(Icons.logout, color: Colors.white54),
            onPressed: _logout,
            tooltip: 'Sign out',
          ),
        ],
        elevation: 0,
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _addProfile,
        backgroundColor: Colors.white,
        foregroundColor: Colors.black,
        child: const Icon(Icons.add),
      ),
      body: _body(),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(
          child: CircularProgressIndicator(color: Colors.white));
    }
    if (_isConnectionError) {
      return ConnectionErrorView(onRetry: _load);
    }

    if (_error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_error!, style: const TextStyle(color: Colors.redAccent)),
            const SizedBox(height: 12),
            TextButton(
              onPressed: _load,
              child: const Text('Retry', style: TextStyle(color: Colors.white)),
            ),
          ],
        ),
      );
    }
    if (_profiles.isEmpty) {
      return const Center(
        child: Text(
          'No profiles yet.\nTap + to add one.',
          textAlign: TextAlign.center,
          style: TextStyle(color: Colors.white54, fontSize: 16),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      color: Colors.white,
      backgroundColor: Colors.grey[900],
      child: ListView.separated(
        padding: const EdgeInsets.all(16),
        itemCount: _profiles.length,
        separatorBuilder: (_, __) => const SizedBox(height: 12),
        itemBuilder: (_, i) => _ProfileCard(
          profile: _profiles[i],
          onTap: () => _openProfile(_profiles[i]),
        ),
      ),
    );
  }
}

class _ProfileCard extends StatelessWidget {
  final Profile profile;
  final VoidCallback onTap;

  const _ProfileCard({required this.profile, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.all(20),
        decoration: BoxDecoration(
          color: Colors.grey[900],
          borderRadius: BorderRadius.circular(16),
          border: Border.all(
            color: profile.hasGmail ? Colors.white24 : Colors.white10,
          ),
        ),
        child: Row(
          children: [
            CircleAvatar(
              radius: 28,
              backgroundColor: Colors.white12,
              backgroundImage: profile.faceUrl != null
                  ? NetworkImage(profile.faceUrl!)
                  : null,
              child: profile.faceUrl == null
                  ? Text(
                      profile.name.isNotEmpty
                          ? profile.name[0].toUpperCase()
                          : '?',
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 22,
                          fontWeight: FontWeight.bold),
                    )
                  : null, // Hide the letter if we have an image
            ),
            const SizedBox(width: 16),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    profile.name,
                    style: const TextStyle(
                        color: Colors.white,
                        fontSize: 18,
                        fontWeight: FontWeight.w600),
                  ),
                  if (profile.email != null)
                    Text(
                      profile.email!,
                      style:
                          const TextStyle(color: Colors.white54, fontSize: 13),
                    )
                  else
                    const Text(
                      'No Gmail connected',
                      style: TextStyle(color: Colors.white24, fontSize: 13),
                    ),
                ],
              ),
            ),
            Icon(
              profile.hasGmail ? Icons.mail_outline : Icons.chevron_right,
              color: profile.hasGmail ? Colors.greenAccent : Colors.white24,
            ),
          ],
        ),
      ),
    );
  }
}
