import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:app_links/app_links.dart';
import 'package:url_launcher/url_launcher.dart';
import '../models/profile.dart';
import '../models/email_message.dart';
import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import 'pair_mirror_screen.dart';

class ProfileScreen extends StatefulWidget {
  final Profile profile;
  const ProfileScreen({super.key, required this.profile});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late Profile _profile;
  List<EmailMessage> _messages = [];
  bool _loadingMessages = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _profile = widget.profile;
    // Always refresh from backend so stale list data never hides Gmail state
    _refreshProfile();
  }

  ApiService get _api => context.read<AuthProvider>().api;

  Future<void> _editProfile() async {
    final nameCtrl = TextEditingController(text: _profile.name);
    final emailCtrl = TextEditingController(text: _profile.email ?? '');
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: Colors.grey[900],
        title: const Text('Edit profile', style: TextStyle(color: Colors.white)),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: nameCtrl,
              style: const TextStyle(color: Colors.white),
              decoration: const InputDecoration(
                labelText: 'Name',
                labelStyle: TextStyle(color: Colors.white54),
                enabledBorder: OutlineInputBorder(
                    borderSide: BorderSide(color: Colors.white24)),
                focusedBorder: OutlineInputBorder(
                    borderSide: BorderSide(color: Colors.white)),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: emailCtrl,
              style: const TextStyle(color: Colors.white),
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(
                labelText: 'Email (optional)',
                labelStyle: TextStyle(color: Colors.white54),
                enabledBorder: OutlineInputBorder(
                    borderSide: BorderSide(color: Colors.white24)),
                focusedBorder: OutlineInputBorder(
                    borderSide: BorderSide(color: Colors.white)),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Cancel', style: TextStyle(color: Colors.white54)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Save', style: TextStyle(color: Colors.white)),
          ),
        ],
      ),
    );
    if (saved != true) return;
    final name = nameCtrl.text.trim();
    if (name.isEmpty) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Name cannot be empty')),
        );
      }
      return;
    }
    try {
      final updated = await _api.updateProfile(
        _profile.id,
        name: name,
        email: emailCtrl.text.trim(),
      );
      if (mounted) setState(() => _profile = updated);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _deleteProfile() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Colors.grey[900],
        title:
            const Text('Delete profile', style: TextStyle(color: Colors.white)),
        content: Text(
          'Delete "${_profile.name}"? This cannot be undone.',
          style: const TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child:
                const Text('Cancel', style: TextStyle(color: Colors.white54)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child:
                const Text('Delete', style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
    );
    if (confirm != true) return;
    try {
      await _api.deleteProfile(_profile.id);
      if (mounted) Navigator.of(context).pop(true); // return true = deleted
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _loadMessages() async {
    setState(() {
      _loadingMessages = true;
      _error = null;
    });
    try {
      final msgs = await _api.getMessages(_profile.id);
      if (mounted) setState(() => _messages = msgs);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loadingMessages = false);
    }
  }

  Future<void> _refreshProfile() async {
    try {
      final updated = await _api.getProfile(_profile.id);
      debugPrint(
          '[Profile] refreshed id=${updated.id} email=${updated.email} googleSub=${updated.googleSub} hasGmail=${updated.hasGmail}');
      if (mounted) {
        setState(() => _profile = updated);
        if (_profile.hasGmail) _loadMessages();
      }
    } on ApiException catch (e) {
      debugPrint(
          '[Profile] refresh ApiException: ${e.message} (${e.statusCode})');
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      debugPrint('[Profile] refresh error: $e');
    }
  }

  Future<void> _connectGmail() async {
    try {
      final url = await _api.getGmailConnectUrl(_profile.id);
      if (!mounted) return;

      // Set up deep-link listener BEFORE opening the browser so we don't miss
      // the redirect while the browser is in the foreground.
      final appLinks = AppLinks();
      final completer = Completer<Uri?>();
      final sub = appLinks.uriLinkStream
          .where((u) => u.scheme == 'smartmirror' && u.host == 'oauth')
          .listen((u) { if (!completer.isCompleted) completer.complete(u); });

      final uri = Uri.parse(url);
      if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        sub.cancel();
        throw ApiException('Could not open browser', 0);
      }

      if (!mounted) { sub.cancel(); return; }

      // Show a waiting dialog — auto-dismissed when the deep link arrives.
      showDialog(
        context: context,
        barrierDismissible: false,
        builder: (_) => AlertDialog(
          backgroundColor: Colors.grey[900],
          title: const Text('Connect Gmail',
              style: TextStyle(color: Colors.white)),
          content: const Text(
            'Complete sign-in in your browser. This dialog will close automatically.',
            style: TextStyle(color: Colors.white70),
          ),
          actions: [
            TextButton(
              onPressed: () {
                if (!completer.isCompleted) completer.complete(null);
              },
              child: const Text('Cancel', style: TextStyle(color: Colors.white54)),
            ),
          ],
        ),
      );

      final callbackUri = await completer.future.timeout(
        const Duration(minutes: 5),
        onTimeout: () => null,
      );
      sub.cancel();

      if (!mounted) return;
      Navigator.of(context, rootNavigator: true).pop(); // dismiss dialog

      if (callbackUri == null) return; // cancelled or timed out

      final error  = callbackUri.queryParameters['error'];
      final status = callbackUri.queryParameters['status'];

      if (error != null) throw ApiException('Google OAuth error: $error', 400);
      if (status != 'connected') {
        throw ApiException('OAuth completed with unexpected status', 400);
      }

      await _refreshProfile();
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    }
  }

  Future<void> _disconnectGmail() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Colors.grey[900],
        title: const Text('Disconnect Gmail',
            style: TextStyle(color: Colors.white)),
        content: const Text(
          'This will remove Gmail access for this profile.',
          style: TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child:
                const Text('Cancel', style: TextStyle(color: Colors.white54)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Disconnect',
                style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
    );

    if (confirm != true) return;

    try {
      await _api.disconnectGmail(_profile.id);
      await _refreshProfile();
      if (mounted) setState(() => _messages = []);
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.message), backgroundColor: Colors.red),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        iconTheme: const IconThemeData(color: Colors.white),
        title: Text(_profile.name,
            style: const TextStyle(
                color: Colors.white, fontWeight: FontWeight.bold)),
        elevation: 0,
        actions: [
          IconButton(
            icon: const Icon(Icons.edit_outlined, color: Colors.white),
            tooltip: 'Edit profile',
            onPressed: _editProfile,
          ),
          IconButton(
            icon: const Icon(Icons.delete_outline, color: Colors.redAccent),
            tooltip: 'Delete profile',
            onPressed: _deleteProfile,
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          // Avatar
          Center(
            child: CircleAvatar(
              radius: 48,
              backgroundColor: Colors.white12,
              backgroundImage: _profile.faceUrl != null
                  ? NetworkImage(_profile.faceUrl!)
                  : null,
              child: _profile.faceUrl == null
                  ? Text(
                      _profile.name.isNotEmpty
                          ? _profile.name[0].toUpperCase()
                          : '?',
                      style: const TextStyle(
                          color: Colors.white,
                          fontSize: 40,
                          fontWeight: FontWeight.bold),
                    )
                  : null,
            ),
          ),
          const SizedBox(height: 16),
          Center(
            child: Text(
              _profile.name,
              style: const TextStyle(
                  color: Colors.white,
                  fontSize: 24,
                  fontWeight: FontWeight.bold),
            ),
          ),
          const SizedBox(height: 32),

          // Mirror ID section
          _MirrorIdSection(
            profile: _profile,
            api: _api,
            onUpdated: (updated) => setState(() => _profile = updated),
          ),
          const SizedBox(height: 16),

          // Spotify section
          _SpotifySection(
            profile: _profile,
            api: _api,
            onUpdated: (updated) => setState(() => _profile = updated),
          ),
          const SizedBox(height: 16),

          // Gmail section
          Container(
            padding: const EdgeInsets.all(20),
            decoration: BoxDecoration(
              color: Colors.grey[900],
              borderRadius: BorderRadius.circular(16),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Icon(Icons.mail_outline,
                        color: Colors.white, size: 20),
                    const SizedBox(width: 8),
                    const Text('Gmail',
                        style: TextStyle(
                            color: Colors.white,
                            fontSize: 16,
                            fontWeight: FontWeight.w600)),
                    const Spacer(),
                    if (_profile.hasGmail)
                      TextButton(
                        onPressed: _disconnectGmail,
                        child: const Text('Disconnect',
                            style: TextStyle(
                                color: Colors.redAccent, fontSize: 13)),
                      ),
                  ],
                ),
                const SizedBox(height: 8),
                if (_profile.hasGmail)
                  Row(
                    children: [
                      const Icon(Icons.check_circle,
                          color: Colors.greenAccent, size: 16),
                      const SizedBox(width: 6),
                      Text(
                        _profile.email!,
                        style: const TextStyle(
                            color: Colors.white54, fontSize: 13),
                      ),
                    ],
                  )
                else ...[
                  const Text(
                    'Connect Gmail to show unread emails on the mirror.',
                    style: TextStyle(color: Colors.white54, fontSize: 13),
                  ),
                  const SizedBox(height: 16),
                  SizedBox(
                    width: double.infinity,
                    height: 46,
                    child: ElevatedButton.icon(
                      onPressed: _connectGmail,
                      icon: const Icon(Icons.add_link),
                      label: const Text('Connect Gmail'),
                      style: ElevatedButton.styleFrom(
                        backgroundColor: Colors.white,
                        foregroundColor: Colors.black,
                        shape: RoundedRectangleBorder(
                            borderRadius: BorderRadius.circular(10)),
                      ),
                    ),
                  ),
                ],
              ],
            ),
          ),

          // Inbox preview
          if (_profile.hasGmail) ...[
            const SizedBox(height: 24),
            Row(
              children: [
                const Text(
                  'Unread inbox',
                  style: TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.w600),
                ),
                const Spacer(),
                IconButton(
                  onPressed: _loadMessages,
                  icon: const Icon(Icons.refresh,
                      color: Colors.white54, size: 20),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (_loadingMessages)
              const Center(
                  child: Padding(
                padding: EdgeInsets.all(24),
                child: CircularProgressIndicator(color: Colors.white),
              ))
            else if (_error != null)
              Text(_error!, style: const TextStyle(color: Colors.redAccent))
            else if (_messages.isEmpty)
              const Text('No unread messages.',
                  style: TextStyle(color: Colors.white54))
            else
              ...(_messages.map((m) => _MessageTile(message: m))),
          ],
        ],
      ),
    );
  }
}

class _MirrorIdSection extends StatefulWidget {
  final Profile profile;
  final ApiService api;
  final void Function(Profile) onUpdated;

  const _MirrorIdSection({
    required this.profile,
    required this.api,
    required this.onUpdated,
  });

  @override
  State<_MirrorIdSection> createState() => _MirrorIdSectionState();
}

class _MirrorIdSectionState extends State<_MirrorIdSection> {
  // Manual-entry fallback
  final TextEditingController _controller = TextEditingController();
  bool _showManual = false;
  bool _loading = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _controller.text = widget.profile.mirrorId ?? '';
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  // ── Set active on mirror ────────────────────────────────────────────────────

  Future<void> _setActive() async {
    final mirrorId = widget.profile.mirrorId;
    if (mirrorId == null) return;
    setState(() { _loading = true; _error = null; });
    try {
      await widget.api.setActiveUser(
        mirrorId: mirrorId,
        profileId: widget.profile.id,
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Now showing on mirror'),
            backgroundColor: Colors.green,
            duration: Duration(seconds: 2),
          ),
        );
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not update mirror');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // ── QR pairing ──────────────────────────────────────────────────────────────

  Future<void> _scanQr() async {
    final mirrorId = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const PairMirrorScreen()),
    );
    if (mirrorId == null || !mounted) return;
    await _linkMirror(mirrorId);
  }

  // ── Manual entry ────────────────────────────────────────────────────────────

  Future<void> _saveManual() async {
    final mirrorId = _controller.text.trim();
    if (mirrorId.isEmpty) {
      setState(() => _error = 'Mirror ID cannot be empty');
      return;
    }
    await _linkMirror(mirrorId);
  }

  // ── Shared save logic ───────────────────────────────────────────────────────

  Future<void> _linkMirror(String mirrorId) async {
    setState(() {
      _loading = true;
      _error   = null;
    });
    try {
      final updated = await widget.api.setMirrorId(widget.profile.id, mirrorId);
      try {
        await widget.api.setActiveUser(mirrorId: mirrorId, profileId: widget.profile.id);
      } catch (_) {}
      widget.onUpdated(updated);
      if (mounted) setState(() => _showManual = false);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Connection error — is the backend running?');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.grey[900],
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // ── Header row ──────────────────────────────────────────────────────
          Row(
            children: [
              const Icon(Icons.tv_outlined, color: Colors.white, size: 20),
              const SizedBox(width: 8),
              const Text('Mirror',
                  style: TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.w600)),
              const Spacer(),
              if (!_showManual && !_loading)
                TextButton(
                  onPressed: _scanQr,
                  child: Text(
                    widget.profile.hasMirror ? 'Re-pair' : 'Pair Mirror',
                    style: const TextStyle(color: Colors.white54, fontSize: 13),
                  ),
                ),
              if (_loading)
                const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white54),
                ),
            ],
          ),

          const SizedBox(height: 8),

          // ── Linked state ────────────────────────────────────────────────────
          if (!_showManual) ...[
            if (widget.profile.hasMirror) ...[
              const Row(
                children: [
                  Icon(Icons.check_circle, color: Colors.greenAccent, size: 16),
                  SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      'Mirror paired',
                      style: TextStyle(color: Colors.white54, fontSize: 13),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              SizedBox(
                width: double.infinity,
                height: 42,
                child: ElevatedButton.icon(
                  onPressed: _loading ? null : _setActive,
                  icon: const Icon(Icons.cast, size: 18),
                  label: const Text('Show on Mirror'),
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: Colors.black,
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10)),
                  ),
                ),
              ),
            ] else
              const Text(
                'Tap "Pair Mirror" and scan the QR code on your mirror.',
                style: TextStyle(color: Colors.white54, fontSize: 13),
              ),

            if (_error != null) ...[
              const SizedBox(height: 6),
              Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 12)),
            ],

            const SizedBox(height: 8),
            GestureDetector(
              onTap: () => setState(() {
                _showManual = true;
                _error = null;
              }),
              child: const Text(
                'Enter ID manually instead',
                style: TextStyle(
                  color: Colors.white24,
                  fontSize: 11,
                  decoration: TextDecoration.underline,
                  decorationColor: Colors.white24,
                ),
              ),
            ),
          ],

          // ── Manual entry fallback ───────────────────────────────────────────
          if (_showManual) ...[
            const SizedBox(height: 4),
            TextField(
              controller: _controller,
              style: const TextStyle(color: Colors.white),
              autofocus: true,
              decoration: const InputDecoration(
                hintText: 'Paste Mirror ID here',
                hintStyle: TextStyle(color: Colors.white24),
                enabledBorder: OutlineInputBorder(
                    borderSide: BorderSide(color: Colors.white24)),
                focusedBorder: OutlineInputBorder(
                    borderSide: BorderSide(color: Colors.white)),
              ),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
            ],
            const SizedBox(height: 12),
            Row(
              children: [
                TextButton(
                  onPressed: _loading ? null : () => setState(() { _showManual = false; _error = null; }),
                  child: const Text('Cancel', style: TextStyle(color: Colors.white54)),
                ),
                const Spacer(),
                ElevatedButton(
                  onPressed: _loading ? null : _saveManual,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Colors.white,
                    foregroundColor: Colors.black,
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                  ),
                  child: _loading
                      ? const SizedBox(
                          height: 16, width: 16,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('Save'),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

// ── Spotify Section ──────────────────────────────────────────────────────────

class _SpotifySection extends StatefulWidget {
  final Profile profile;
  final ApiService api;
  final void Function(Profile) onUpdated;

  const _SpotifySection({
    required this.profile,
    required this.api,
    required this.onUpdated,
  });

  @override
  State<_SpotifySection> createState() => _SpotifySectionState();
}

class _SpotifySectionState extends State<_SpotifySection> {
  bool _loading = false;
  String? _error;

  Future<void> _connect() async {
    setState(() { _loading = true; _error = null; });
    StreamSubscription<Uri>? linkSub;
    try {
      final profileId = widget.profile.id;
      debugPrint('[Spotify] connecting profileId=$profileId');

      final url = await widget.api.getSpotifyConnectUrl(profileId);
      if (!mounted) return;

      // Listen for the deep-link callback before opening the browser
      final completer = Completer<Uri?>();
      linkSub = AppLinks().uriLinkStream.listen((uri) {
        if (!completer.isCompleted &&
            uri.scheme == 'smartmirror' &&
            uri.path.contains('spotify')) {
          completer.complete(uri);
        }
      });

      final uri = Uri.parse(url);
      if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
        throw ApiException('Could not open browser', 0);
      }

      if (!mounted) return;
      showDialog<void>(
        context: context,
        barrierDismissible: false,
        builder: (ctx) => AlertDialog(
          backgroundColor: Colors.grey[900],
          title: const Text('Connect Spotify',
              style: TextStyle(color: Colors.white)),
          content: const Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator(color: Color(0xFF1DB954)),
              SizedBox(height: 16),
              Text(
                'Sign in with Spotify in your browser.\nYou\'ll be returned here automatically.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white70),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () {
                if (!completer.isCompleted) completer.complete(null);
                Navigator.pop(ctx);
              },
              child: const Text('Cancel', style: TextStyle(color: Colors.white54)),
            ),
          ],
        ),
      );

      final callbackUri = await completer.future;
      if (mounted && Navigator.canPop(context)) Navigator.pop(context);
      if (callbackUri == null) return; // cancelled

      final code = callbackUri.queryParameters['code'];
      if (code == null) throw ApiException('No authorisation code in callback', 0);

      debugPrint('[Spotify] exchanging code for profileId=$profileId');
      await widget.api.exchangeSpotifyCode(profileId, code);

      final updated = await widget.api.getProfile(profileId);
      debugPrint('[Spotify] connected: displayName=${updated.spotifyDisplayName}');
      if (mounted) widget.onUpdated(updated);

    } on ApiException catch (e) {
      debugPrint('[Spotify] ApiException: ${e.message} (${e.statusCode})');
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      debugPrint('[Spotify] error: $e');
      if (mounted) setState(() => _error = 'Connection error — is the backend running?');
    } finally {
      linkSub?.cancel();
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _disconnect() async {
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Colors.grey[900],
        title: const Text('Disconnect Spotify',
            style: TextStyle(color: Colors.white)),
        content: const Text(
          'This will remove Spotify access for this profile.',
          style: TextStyle(color: Colors.white70),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child:
                const Text('Cancel', style: TextStyle(color: Colors.white54)),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Disconnect',
                style: TextStyle(color: Colors.redAccent)),
          ),
        ],
      ),
    );
    if (confirm != true) return;

    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await widget.api.disconnectSpotify(widget.profile.id);
      final updated = await widget.api.getProfile(widget.profile.id);
      if (mounted) widget.onUpdated(updated);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final connected = widget.profile.hasSpotify;
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Colors.grey[900],
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              // Spotify logo colour dot
              Container(
                width: 20,
                height: 20,
                decoration: const BoxDecoration(
                  color: Color(0xFF1DB954),
                  shape: BoxShape.circle,
                ),
                child:
                    const Icon(Icons.music_note, color: Colors.white, size: 13),
              ),
              const SizedBox(width: 8),
              const Text('Spotify',
                  style: TextStyle(
                      color: Colors.white,
                      fontSize: 16,
                      fontWeight: FontWeight.w600)),
              const Spacer(),
              if (_loading)
                const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                        strokeWidth: 2, color: Colors.white54))
              else if (connected)
                TextButton(
                  onPressed: _disconnect,
                  child: const Text('Disconnect',
                      style: TextStyle(color: Colors.redAccent, fontSize: 13)),
                ),
            ],
          ),
          const SizedBox(height: 8),
          if (connected) ...[
            Row(
              children: [
                const Icon(Icons.check_circle,
                    color: Colors.greenAccent, size: 16),
                const SizedBox(width: 6),
                Text(
                  widget.profile.spotifyDisplayName ?? 'Connected',
                  style: const TextStyle(color: Colors.white54, fontSize: 13),
                ),
              ],
            ),
          ] else ...[
            const Text(
              'Connect Spotify to show what\'s playing on the mirror.',
              style: TextStyle(color: Colors.white54, fontSize: 13),
            ),
            if (_error != null) ...[
              const SizedBox(height: 6),
              Text(_error!,
                  style:
                      const TextStyle(color: Colors.redAccent, fontSize: 12)),
            ],
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              height: 46,
              child: ElevatedButton.icon(
                onPressed: _loading ? null : _connect,
                icon: const Icon(Icons.music_note),
                label: const Text('Connect Spotify'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: const Color(0xFF1DB954),
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(10)),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

// ── Message Tile ─────────────────────────────────────────────────────────────

class _MessageTile extends StatelessWidget {
  final EmailMessage message;
  const _MessageTile({required this.message});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: Colors.grey[900],
        borderRadius: BorderRadius.circular(12),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            message.subject,
            style: const TextStyle(
                color: Colors.white, fontWeight: FontWeight.w600),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 4),
          Text(
            message.from,
            style: const TextStyle(color: Colors.white54, fontSize: 12),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 6),
          Text(
            message.snippet,
            style: const TextStyle(color: Colors.white38, fontSize: 12),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          ),
        ],
      ),
    );
  }
}
