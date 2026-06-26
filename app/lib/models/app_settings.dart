import 'decode.dart';

// Household-wide shared settings (keys + AI config) mirrored across the app and
// the mirror via the backend (/api/settings). Secrets are never returned by the
// backend — only `<field>Configured` booleans — so the UI shows whether a key is
// set and only sends a new secret when the user types one.
class AppSettings {
  final bool openaiConfigured;
  final String chatModel;
  final String realtimeModel;
  final String voice;
  final String assistantName;
  final bool elevenLabsConfigured;
  final String elevenLabsVoiceId;
  final bool showRawTranscripts;
  final bool replicateConfigured;
  final String replicateModel;
  final String replicateTxt2imgModel;
  final String publicBaseUrl;

  AppSettings({
    this.openaiConfigured = false,
    this.chatModel = 'gpt-4o',
    this.realtimeModel = 'gpt-4o-realtime-preview-2024-12-17',
    this.voice = 'alloy',
    this.assistantName = 'Mirror',
    this.elevenLabsConfigured = false,
    this.elevenLabsVoiceId = '',
    this.showRawTranscripts = false,
    this.replicateConfigured = false,
    this.replicateModel = '',
    this.replicateTxt2imgModel = '',
    this.publicBaseUrl = '',
  });

  factory AppSettings.fromJson(Map<String, dynamic> json) => AppSettings(
        openaiConfigured: parseBool(json['openaiApiKeyConfigured']),
        chatModel: parseStringOrNull(json['chatModel']) ?? 'gpt-4o',
        realtimeModel: parseStringOrNull(json['realtimeModel']) ??
            'gpt-4o-realtime-preview-2024-12-17',
        voice: parseStringOrNull(json['voice']) ?? 'alloy',
        assistantName: parseStringOrNull(json['assistantName']) ?? 'Mirror',
        elevenLabsConfigured: parseBool(json['elevenLabsKeyConfigured']),
        elevenLabsVoiceId: parseStringOrNull(json['elevenLabsVoiceId']) ?? '',
        showRawTranscripts: parseBool(json['showRawTranscripts']),
        replicateConfigured: parseBool(json['replicateApiTokenConfigured']),
        replicateModel: parseStringOrNull(json['replicateModel']) ?? '',
        replicateTxt2imgModel:
            parseStringOrNull(json['replicateTxt2imgModel']) ?? '',
        publicBaseUrl: parseStringOrNull(json['publicBaseUrl']) ?? '',
      );
}
