class SecurityAlert {
  final int id;
  final String mirrorId;
  final String alertType;
  final double? confidence;
  final String? imageUrl;
  final DateTime timestamp;

  SecurityAlert({
    required this.id,
    required this.mirrorId,
    required this.alertType,
    this.confidence,
    this.imageUrl,
    required this.timestamp,
  });

  factory SecurityAlert.fromJson(Map<String, dynamic> json) {
    return SecurityAlert(
      id: json['id'] as int,
      mirrorId: (json['mirrorId'] as String?) ?? '',
      alertType: (json['alertType'] as String?) ?? 'UNKNOWN',
      confidence: (json['confidence'] as num?)?.toDouble(),
      imageUrl: json['imageUrl'] as String?,
      timestamp: DateTime.parse(json['timestamp'] as String),
    );
  }

  // Human-readable label for the alert type.
  String get typeLabel {
    switch (alertType) {
      case 'UNKNOWN_FACE_DETECTED':
        return 'Unknown Face Detected';
      default:
        return alertType.replaceAll('_', ' ');
    }
  }
}
