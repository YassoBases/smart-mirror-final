import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/ai_settings.dart';
import '../models/profile.dart';
import '../providers/auth_provider.dart';
import '../services/api_service.dart';

const _kRealtimeModels = [
  ('gpt-4o-realtime-preview-2024-12-17', 'GPT-4o Realtime (Dec 2024) — recommended'),
  ('gpt-4o-mini-realtime-preview-2024-12-17', 'GPT-4o mini Realtime (Dec 2024) — faster'),
  ('gpt-4o-realtime-preview', 'GPT-4o Realtime (latest alias)'),
  ('gpt-4o-mini-realtime-preview', 'GPT-4o mini Realtime (latest alias)'),
];

const _kChatModels = [
  ('gpt-4o', 'GPT-4o — recommended'),
  ('gpt-4o-mini', 'GPT-4o mini — faster & cheaper'),
  ('gpt-4.1', 'GPT-4.1'),
  ('gpt-4.1-mini', 'GPT-4.1 mini'),
  ('gpt-4-turbo', 'GPT-4 Turbo'),
];

const _kVoices = [
  ('alloy', 'Alloy'),
  ('ash', 'Ash'),
  ('ballad', 'Ballad'),
  ('coral', 'Coral'),
  ('echo', 'Echo'),
  ('sage', 'Sage'),
  ('shimmer', 'Shimmer'),
  ('verse', 'Verse'),
  ('aria', 'Aria'),
];

class AiSettingsScreen extends StatefulWidget {
  final Profile profile;
  const AiSettingsScreen({super.key, required this.profile});

  @override
  State<AiSettingsScreen> createState() => _AiSettingsScreenState();
}

class _AiSettingsScreenState extends State<AiSettingsScreen> {
  AiSettings _settings = const AiSettings();
  bool _loading = true;
  bool _saving = false;
  String? _error;

  bool _showApiKey = false;
  bool _showElevenLabsKey = false;

  late final TextEditingController _apiKeyCtrl;
  late final TextEditingController _nameCtrl;
  late final TextEditingController _elevenLabsKeyCtrl;
  late final TextEditingController _elevenLabsVoiceIdCtrl;

  @override
  void initState() {
    super.initState();
    _apiKeyCtrl = TextEditingController();
    _nameCtrl = TextEditingController();
    _elevenLabsKeyCtrl = TextEditingController();
    _elevenLabsVoiceIdCtrl = TextEditingController();
    _load();
  }

  @override
  void dispose() {
    _apiKeyCtrl.dispose();
    _nameCtrl.dispose();
    _elevenLabsKeyCtrl.dispose();
    _elevenLabsVoiceIdCtrl.dispose();
    super.dispose();
  }

  ApiService get _api => context.read<AuthProvider>().api;

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final s = await _api.getAiSettings(widget.profile.id);
      if (mounted) {
        setState(() => _settings = s);
        _apiKeyCtrl.text = s.apiKey;
        _nameCtrl.text = s.name;
        _elevenLabsKeyCtrl.text = s.elevenLabsKey;
        _elevenLabsVoiceIdCtrl.text = s.elevenLabsVoiceId;
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    final updated = _settings.copyWith(
      apiKey: _apiKeyCtrl.text.trim(),
      name: _nameCtrl.text.trim().isEmpty ? 'Mirror' : _nameCtrl.text.trim(),
      elevenLabsKey: _elevenLabsKeyCtrl.text.trim(),
      elevenLabsVoiceId: _elevenLabsVoiceIdCtrl.text.trim(),
    );

    setState(() { _saving = true; _error = null; });
    try {
      final saved = await _api.saveAiSettings(widget.profile.id, updated);
      if (mounted) {
        setState(() => _settings = saved);
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('AI settings saved'),
            backgroundColor: Colors.green,
            duration: Duration(seconds: 2),
          ),
        );
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        iconTheme: const IconThemeData(color: Colors.white),
        title: Text('AI Assistant — ${widget.profile.name}',
            style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        elevation: 0,
        actions: [
          if (!_loading)
            TextButton(
              onPressed: _saving ? null : _save,
              child: _saving
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.white))
                  : const Text('Save',
                      style: TextStyle(
                          color: Colors.white, fontWeight: FontWeight.w600)),
            ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Colors.white))
          : ListView(
              padding: const EdgeInsets.all(20),
              children: [
                if (_error != null) ...[
                  Text(_error!,
                      style: const TextStyle(color: Colors.redAccent)),
                  const SizedBox(height: 16),
                ],

                // ── Enable toggle ──────────────────────────────────────────
                _Card(
                  child: Row(
                    children: [
                      const Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Enable AI Assistant',
                                style: TextStyle(
                                    color: Colors.white,
                                    fontSize: 16,
                                    fontWeight: FontWeight.w600)),
                            SizedBox(height: 4),
                            Text(
                              'Listens for "Hey Mirror" to start a voice conversation.',
                              style:
                                  TextStyle(color: Colors.white54, fontSize: 13),
                            ),
                          ],
                        ),
                      ),
                      Switch(
                        value: _settings.enabled,
                        activeThumbColor: Colors.white,
                        onChanged: (v) =>
                            setState(() => _settings = _settings.copyWith(enabled: v)),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),

                if (_settings.apiKey.isEmpty) ...[
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.amber.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(12),
                      border:
                          Border.all(color: Colors.amber.withValues(alpha: 0.3)),
                    ),
                    child: const Text(
                      'Add your OpenAI API key below to enable the voice assistant.',
                      style: TextStyle(color: Colors.amber, fontSize: 13),
                    ),
                  ),
                  const SizedBox(height: 12),
                ],

                // ── OpenAI API Key ─────────────────────────────────────────
                _Card(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const _Label('OpenAI API Key'),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _apiKeyCtrl,
                              obscureText: !_showApiKey,
                              style: const TextStyle(
                                  color: Colors.white, fontFamily: 'monospace'),
                              decoration: _inputDecoration('sk-...'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          TextButton(
                            onPressed: () =>
                                setState(() => _showApiKey = !_showApiKey),
                            child: Text(
                              _showApiKey ? 'Hide' : 'Show',
                              style:
                                  const TextStyle(color: Colors.white54, fontSize: 13),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Stored per profile — the mirror uses this key when you are the active user.',
                        style: TextStyle(color: Colors.white24, fontSize: 11),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),

                // ── Models & Voice ─────────────────────────────────────────
                _Card(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const _Label('Voice (Realtime) Model'),
                      const SizedBox(height: 8),
                      _Dropdown(
                        value: _settings.realtimeModel,
                        items: _kRealtimeModels,
                        onChanged: (v) => setState(
                            () => _settings = _settings.copyWith(realtimeModel: v)),
                      ),
                      const SizedBox(height: 16),
                      const _Label('Chat (Text / Fallback) Model'),
                      const SizedBox(height: 8),
                      _Dropdown(
                        value: _settings.chatModel,
                        items: _kChatModels,
                        onChanged: (v) => setState(
                            () => _settings = _settings.copyWith(chatModel: v)),
                      ),
                      const SizedBox(height: 16),
                      const _Label('Voice'),
                      const SizedBox(height: 8),
                      _Dropdown(
                        value: _settings.voice,
                        items: _kVoices,
                        onChanged: (v) => setState(
                            () => _settings = _settings.copyWith(voice: v)),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),

                // ── Assistant name ─────────────────────────────────────────
                _Card(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const _Label('Assistant Name'),
                      const SizedBox(height: 8),
                      TextField(
                        controller: _nameCtrl,
                        style: const TextStyle(color: Colors.white),
                        decoration: _inputDecoration('Mirror'),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        'The mirror listens for "Hey ${_nameCtrl.text.trim().isEmpty ? 'Mirror' : _nameCtrl.text.trim()}".',
                        style:
                            const TextStyle(color: Colors.white24, fontSize: 11),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),

                // ── ElevenLabs ─────────────────────────────────────────────
                _Card(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const _Label('ElevenLabs API Key'),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Expanded(
                            child: TextField(
                              controller: _elevenLabsKeyCtrl,
                              obscureText: !_showElevenLabsKey,
                              style: const TextStyle(
                                  color: Colors.white, fontFamily: 'monospace'),
                              decoration: _inputDecoration('sk_...'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          TextButton(
                            onPressed: () => setState(
                                () => _showElevenLabsKey = !_showElevenLabsKey),
                            child: Text(
                              _showElevenLabsKey ? 'Hide' : 'Show',
                              style:
                                  const TextStyle(color: Colors.white54, fontSize: 13),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'For high-quality voice output. Leave blank to use the browser fallback.',
                        style: TextStyle(color: Colors.white24, fontSize: 11),
                      ),
                      const SizedBox(height: 16),
                      const _Label('ElevenLabs Voice ID'),
                      const SizedBox(height: 8),
                      TextField(
                        controller: _elevenLabsVoiceIdCtrl,
                        style: const TextStyle(
                            color: Colors.white, fontFamily: 'monospace'),
                        decoration:
                            _inputDecoration('JBFqnCBsd6RMkjVDRZzb'),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Find IDs at elevenlabs.io/voice-lab. Default: George (British).',
                        style: TextStyle(color: Colors.white24, fontSize: 11),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),

                // ── Debug ──────────────────────────────────────────────────
                _Card(
                  child: Row(
                    children: [
                      Checkbox(
                        value: _settings.showRawTranscripts,
                        activeColor: Colors.white,
                        checkColor: Colors.black,
                        side: const BorderSide(color: Colors.white38),
                        onChanged: (v) => setState(() =>
                            _settings = _settings.copyWith(
                                showRawTranscripts: v ?? false)),
                      ),
                      const SizedBox(width: 8),
                      const Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text('Show raw speech-to-text for debugging',
                                style:
                                    TextStyle(color: Colors.white54, fontSize: 14)),
                            SizedBox(height: 2),
                            Text(
                              'Displays the live transcript to confirm hotword detection.',
                              style:
                                  TextStyle(color: Colors.white24, fontSize: 11),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 32),
                SizedBox(
                  width: double.infinity,
                  height: 50,
                  child: ElevatedButton(
                    onPressed: _saving ? null : _save,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: Colors.white,
                      foregroundColor: Colors.black,
                      shape: RoundedRectangleBorder(
                          borderRadius: BorderRadius.circular(12)),
                    ),
                    child: _saving
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                                strokeWidth: 2, color: Colors.black))
                        : const Text('Save Settings',
                            style: TextStyle(
                                fontWeight: FontWeight.w600, fontSize: 16)),
                  ),
                ),
                const SizedBox(height: 24),
              ],
            ),
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

InputDecoration _inputDecoration(String hint) => InputDecoration(
      hintText: hint,
      hintStyle: const TextStyle(color: Colors.white24),
      filled: true,
      fillColor: Colors.white.withValues(alpha: 0.05),
      contentPadding:
          const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Colors.white12),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(10),
        borderSide: const BorderSide(color: Colors.white38),
      ),
    );

class _Card extends StatelessWidget {
  final Widget child;
  const _Card({required this.child});

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Colors.grey[900],
          borderRadius: BorderRadius.circular(16),
        ),
        child: child,
      );
}

class _Label extends StatelessWidget {
  final String text;
  const _Label(this.text);

  @override
  Widget build(BuildContext context) => Text(
        text,
        style: const TextStyle(
            color: Colors.white70,
            fontSize: 12,
            fontWeight: FontWeight.w600,
            letterSpacing: 0.5),
      );
}

class _Dropdown extends StatelessWidget {
  final String value;
  final List<(String, String)> items;
  final void Function(String) onChanged;

  const _Dropdown({
    required this.value,
    required this.items,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    final safeValue = items.any((e) => e.$1 == value) ? value : items.first.$1;
    return DropdownButtonFormField<String>(
      initialValue: safeValue,
      isExpanded: true,
      dropdownColor: Colors.grey[850],
      style: const TextStyle(color: Colors.white, fontSize: 14),
      decoration: InputDecoration(
        filled: true,
        fillColor: Colors.white.withValues(alpha: 0.05),
        contentPadding:
            const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: Colors.white12),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(10),
          borderSide: const BorderSide(color: Colors.white38),
        ),
      ),
      icon: const Icon(Icons.arrow_drop_down, color: Colors.white54),
      items: items
          .map((e) => DropdownMenuItem(
                value: e.$1,
                child: Text(e.$2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Colors.white)),
              ))
          .toList(),
      onChanged: (v) { if (v != null) onChanged(v); },
    );
  }
}
