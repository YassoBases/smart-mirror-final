class AiSettings {
  final bool enabled;
  final String apiKey;
  final String realtimeModel;
  final String chatModel;
  final String voice;
  final String name;
  final String elevenLabsKey;
  final String elevenLabsVoiceId;
  final bool showRawTranscripts;

  const AiSettings({
    this.enabled = false,
    this.apiKey = '',
    this.realtimeModel = 'gpt-4o-realtime-preview-2024-12-17',
    this.chatModel = 'gpt-4o',
    this.voice = 'alloy',
    this.name = 'Mirror',
    this.elevenLabsKey = '',
    this.elevenLabsVoiceId = '',
    this.showRawTranscripts = false,
  });

  factory AiSettings.fromJson(Map<String, dynamic> json) => AiSettings(
        enabled: json['enabled'] == true,
        apiKey: json['apiKey'] ?? '',
        realtimeModel:
            json['realtimeModel'] ?? 'gpt-4o-realtime-preview-2024-12-17',
        chatModel: json['chatModel'] ?? 'gpt-4o',
        voice: json['voice'] ?? 'alloy',
        name: json['name'] ?? 'Mirror',
        elevenLabsKey: json['elevenLabsKey'] ?? '',
        elevenLabsVoiceId: json['elevenLabsVoiceId'] ?? '',
        showRawTranscripts: json['showRawTranscripts'] == true,
      );

  Map<String, dynamic> toJson() => {
        'enabled': enabled,
        'apiKey': apiKey,
        'realtimeModel': realtimeModel,
        'chatModel': chatModel,
        'voice': voice,
        'name': name,
        'elevenLabsKey': elevenLabsKey,
        'elevenLabsVoiceId': elevenLabsVoiceId,
        'showRawTranscripts': showRawTranscripts,
      };

  AiSettings copyWith({
    bool? enabled,
    String? apiKey,
    String? realtimeModel,
    String? chatModel,
    String? voice,
    String? name,
    String? elevenLabsKey,
    String? elevenLabsVoiceId,
    bool? showRawTranscripts,
  }) =>
      AiSettings(
        enabled: enabled ?? this.enabled,
        apiKey: apiKey ?? this.apiKey,
        realtimeModel: realtimeModel ?? this.realtimeModel,
        chatModel: chatModel ?? this.chatModel,
        voice: voice ?? this.voice,
        name: name ?? this.name,
        elevenLabsKey: elevenLabsKey ?? this.elevenLabsKey,
        elevenLabsVoiceId: elevenLabsVoiceId ?? this.elevenLabsVoiceId,
        showRawTranscripts: showRawTranscripts ?? this.showRawTranscripts,
      );
}
