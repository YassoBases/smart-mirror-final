class EmailMessage {
  final String id;
  final String subject;
  final String from;
  final String snippet;

  EmailMessage({
    required this.id,
    required this.subject,
    required this.from,
    required this.snippet,
  });

  factory EmailMessage.fromJson(Map<String, dynamic> json) => EmailMessage(
        id: json['id'],
        subject: json['subject'] ?? '(no subject)',
        from: json['from'] ?? '',
        snippet: json['snippet'] ?? '',
      );
}
