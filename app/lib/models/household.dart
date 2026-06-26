class Household {
  final int id;
  final String name;
  final String createdAt;

  Household({required this.id, required this.name, required this.createdAt});

  factory Household.fromJson(Map<String, dynamic> json) => Household(
        id: json['id'],
        name: json['name'],
        createdAt: json['created_at'] ?? '',
      );
}
