import 'decode.dart';

// Optional demo metrics: weekly suggestion-acceptance buckets plus the time the
// model was last trained.
class AcceptanceBucket {
  final String? weekStart;
  final int total;
  final int accepted;
  final double rate; // 0..1

  AcceptanceBucket({
    this.weekStart,
    this.total = 0,
    this.accepted = 0,
    this.rate = 0,
  });

  factory AcceptanceBucket.fromJson(Map<String, dynamic> json) =>
      AcceptanceBucket(
        weekStart: parseStringOrNull(firstOf(json, ['weekStart', 'week_start'])),
        total: parseInt(json['total']),
        accepted: parseInt(json['accepted']),
        rate: parseDouble(json['rate']),
      );
}

class AcceptanceMetrics {
  final List<AcceptanceBucket> buckets;
  final String? modelTrainedAt;

  AcceptanceMetrics({this.buckets = const [], this.modelTrainedAt});

  factory AcceptanceMetrics.fromJson(Map<String, dynamic> json) {
    final raw = firstOf(json, ['buckets']);
    final buckets = raw is List
        ? raw
            .whereType<Map>()
            .map((b) => AcceptanceBucket.fromJson(Map<String, dynamic>.from(b)))
            .toList()
        : <AcceptanceBucket>[];
    return AcceptanceMetrics(
      buckets: buckets,
      modelTrainedAt:
          parseStringOrNull(firstOf(json, ['modelTrainedAt', 'model_trained_at'])),
    );
  }
}
