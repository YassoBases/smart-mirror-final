import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/app_settings.dart';
import '../providers/auth_provider.dart';
import '../services/api_service.dart';
import '../widgets/connection_error_view.dart';

// Household shared settings (keys + AI config). Synced with the mirror via the
// backend: saving here shows up on the mirror, and changes made on the mirror
// show here. Secrets are write-only — the backend reports only whether each is
// configured; leave a key field blank to keep the stored value.
class AppSettingsScreen extends StatefulWidget {
  const AppSettingsScreen({super.key});

  @override
  State<AppSettingsScreen> createState() => _AppSettingsScreenState();
}

const _voices = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'aria'
];

class _AppSettingsScreenState extends State<AppSettingsScreen> {
  bool _loading = true;
  bool _connectionError = false;
  String? _error;
  bool _saving = false;
  AppSettings _settings = AppSettings();

  final _openaiKey = TextEditingController();
  final _chatModel = TextEditingController();
  final _assistantName = TextEditingController();
  final _elevenKey = TextEditingController();
  final _elevenVoiceId = TextEditingController();
  final _replicateToken = TextEditingController();
  final _replicateModel = TextEditingController();
  final _replicateTxt2img = TextEditingController();
  final _publicBaseUrl = TextEditingController();
  String _voice = 'alloy';
  bool _showRawTranscripts = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    for (final c in [
      _openaiKey, _chatModel, _assistantName, _elevenKey, _elevenVoiceId,
      _replicateToken, _replicateModel, _replicateTxt2img, _publicBaseUrl
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  ApiService get _api => context.read<AuthProvider>().api;

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _connectionError = false;
      _error = null;
    });
    try {
      final s = await _api.getSettings();
      if (!mounted) return;
      setState(() {
        _settings = s;
        _chatModel.text = s.chatModel;
        _assistantName.text = s.assistantName;
        _elevenVoiceId.text = s.elevenLabsVoiceId;
        _replicateModel.text = s.replicateModel;
        _replicateTxt2img.text = s.replicateTxt2imgModel;
        _publicBaseUrl.text = s.publicBaseUrl;
        _voice = _voices.contains(s.voice) ? s.voice : 'alloy';
        _showRawTranscripts = s.showRawTranscripts;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (mounted) setState(() { _error = e.message; _loading = false; });
    } catch (_) {
      if (mounted) setState(() { _connectionError = true; _loading = false; });
    }
  }

  Future<void> _save() async {
    setState(() { _saving = true; _error = null; });
    final patch = <String, dynamic>{
      'chatModel': _chatModel.text.trim(),
      'voice': _voice,
      'assistantName': _assistantName.text.trim(),
      'elevenLabsVoiceId': _elevenVoiceId.text.trim(),
      'showRawTranscripts': _showRawTranscripts,
      'replicateModel': _replicateModel.text.trim(),
      'replicateTxt2imgModel': _replicateTxt2img.text.trim(),
      'publicBaseUrl': _publicBaseUrl.text.trim(),
    };
    // Only send secrets when the user actually typed one.
    if (_openaiKey.text.trim().isNotEmpty) patch['openaiApiKey'] = _openaiKey.text.trim();
    if (_elevenKey.text.trim().isNotEmpty) patch['elevenLabsKey'] = _elevenKey.text.trim();
    if (_replicateToken.text.trim().isNotEmpty) patch['replicateApiToken'] = _replicateToken.text.trim();

    try {
      final s = await _api.saveSettings(patch);
      if (!mounted) return;
      setState(() {
        _settings = s;
        _openaiKey.clear();
        _elevenKey.clear();
        _replicateToken.clear();
        _saving = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Settings saved'), backgroundColor: Colors.green),
      );
    } on ApiException catch (e) {
      if (mounted) setState(() { _error = e.message; _saving = false; });
    } catch (_) {
      if (mounted) {
        setState(() { _error = 'Connection error — could not save settings'; _saving = false; });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        elevation: 0,
        iconTheme: const IconThemeData(color: Colors.white),
        title: const Text('Settings',
            style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
      ),
      body: _body(),
    );
  }

  Widget _body() {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: Colors.white));
    }
    if (_connectionError) {
      return ConnectionErrorView(onRetry: _load);
    }
    return ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text('These settings are shared with the mirror.',
            style: TextStyle(color: Colors.white54, fontSize: 13)),
        const SizedBox(height: 20),
        _sectionTitle('AI (OpenAI)'),
        _secretField('OpenAI API key', _openaiKey, _settings.openaiConfigured),
        _textField('Chat model', _chatModel, hint: 'gpt-4o'),
        _voiceDropdown(),
        _textField('Assistant name', _assistantName, hint: 'Mirror'),
        _switchRow('Show raw transcripts', _showRawTranscripts,
            (v) => setState(() => _showRawTranscripts = v)),
        const SizedBox(height: 8),
        _sectionTitle('Voice (ElevenLabs, optional)'),
        _secretField('ElevenLabs API key', _elevenKey, _settings.elevenLabsConfigured),
        _textField('ElevenLabs voice ID', _elevenVoiceId),
        const SizedBox(height: 8),
        _sectionTitle('Replicate (virtual try-on + image generation)'),
        _secretField('Replicate API token', _replicateToken, _settings.replicateConfigured),
        _textField('VTON model', _replicateModel,
            hint: 'owner/name:version (blank = default)'),
        _textField('Text-to-image model', _replicateTxt2img,
            hint: 'owner/name:version (blank = default)'),
        _textField('Public base URL', _publicBaseUrl,
            hint: 'https://... (for VTON image fetch)'),
        if (_error != null) ...[
          const SizedBox(height: 16),
          Text(_error!,
              style: const TextStyle(color: Colors.redAccent),
              textAlign: TextAlign.center),
        ],
        const SizedBox(height: 24),
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
                : const Text('Save',
                    style:
                        TextStyle(fontSize: 16, fontWeight: FontWeight.w600)),
          ),
        ),
      ],
    );
  }

  Widget _sectionTitle(String t) => Padding(
        padding: const EdgeInsets.only(top: 12, bottom: 10),
        child: Text(t,
            style: const TextStyle(
                color: Colors.white,
                fontSize: 16,
                fontWeight: FontWeight.w600)),
      );

  Widget _textField(String label, TextEditingController c, {String? hint}) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(label,
                style: const TextStyle(color: Colors.white70, fontSize: 13)),
            const SizedBox(height: 6),
            TextField(
              controller: c,
              style: const TextStyle(color: Colors.white),
              decoration: InputDecoration(
                hintText: hint,
                hintStyle: const TextStyle(color: Colors.white24),
                isDense: true,
                enabledBorder: const OutlineInputBorder(
                    borderSide: BorderSide(color: Colors.white24)),
                focusedBorder: const OutlineInputBorder(
                    borderSide: BorderSide(color: Colors.white)),
              ),
            ),
          ],
        ),
      );

  // Secret field: shows whether a value is already stored; leave blank to keep it.
  Widget _secretField(String label, TextEditingController c, bool configured) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(label,
                    style:
                        const TextStyle(color: Colors.white70, fontSize: 13)),
                const SizedBox(width: 8),
                Text(configured ? '(configured)' : '(not set)',
                    style: TextStyle(
                        color: configured
                            ? Colors.greenAccent
                            : Colors.white38,
                        fontSize: 11)),
              ],
            ),
            const SizedBox(height: 6),
            TextField(
              controller: c,
              obscureText: true,
              style: const TextStyle(color: Colors.white),
              decoration: InputDecoration(
                hintText: configured ? 'Leave blank to keep' : 'Enter key',
                hintStyle: const TextStyle(color: Colors.white24),
                isDense: true,
                enabledBorder: const OutlineInputBorder(
                    borderSide: BorderSide(color: Colors.white24)),
                focusedBorder: const OutlineInputBorder(
                    borderSide: BorderSide(color: Colors.white)),
              ),
            ),
          ],
        ),
      );

  Widget _voiceDropdown() => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Voice',
                style: TextStyle(color: Colors.white70, fontSize: 13)),
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                border: Border.all(color: Colors.white24),
                borderRadius: BorderRadius.circular(4),
              ),
              child: DropdownButtonHideUnderline(
                child: DropdownButton<String>(
                  value: _voice,
                  isExpanded: true,
                  dropdownColor: Colors.grey[900],
                  style: const TextStyle(color: Colors.white),
                  items: _voices
                      .map((v) =>
                          DropdownMenuItem(value: v, child: Text(v)))
                      .toList(),
                  onChanged: (v) =>
                      setState(() => _voice = v ?? _voice),
                ),
              ),
            ),
          ],
        ),
      );

  Widget _switchRow(String label, bool value, ValueChanged<bool> onChanged) =>
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: Row(
          children: [
            Expanded(
              child: Text(label,
                  style: const TextStyle(color: Colors.white70, fontSize: 13)),
            ),
            Switch(
              value: value,
              activeThumbColor: Colors.white,
              onChanged: onChanged,
            ),
          ],
        ),
      );
}
