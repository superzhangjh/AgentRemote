import 'dart:convert';
import 'dart:io';

/// A temporary file host the Mac can upload to so a phone can download the file
/// over the public CDN instead of the (often slow) Tailscale upload path.
///
/// Only providers whose anonymous upload API is known to work are listed. The
/// two here were verified with `curl` from the project's own network. Services
/// that were tried but are unreachable from this network or whose anonymous API
/// changed (文叔叔, 奶牛快传, 空投 portal, tmp.link) are intentionally absent.
enum RelayProvider {
  tmpfiles('tmpfiles.org', 'https://tmpfiles.org/api/v1/upload', 'file'),
  uguu('uguu.se', 'https://uguu.se/upload?output=text', 'files[]');

  const RelayProvider(this.label, this.endpoint, this.fieldName);

  final String label;
  final String endpoint;
  final String fieldName;
}

class RelayUploadResult {
  const RelayUploadResult({
    required this.provider,
    required this.url,
    required this.fileName,
    required this.size,
  });

  final RelayProvider provider;
  final String url;
  final String fileName;
  final int size;
}

class RelayException implements Exception {
  const RelayException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// Streams a file to a [RelayProvider] with a byte-level progress callback and
/// no third-party dependency (plain `dart:io` multipart upload).
class FileRelay {
  static const int _chunkSize = 256 * 1024;

  static Future<RelayUploadResult> upload(
    File file,
    RelayProvider provider, {
    void Function(double progress)? onProgress,
  }) async {
    final size = await file.length();
    final fileName = _baseName(file.path);
    final safeName = fileName.replaceAll(RegExp(r'["\r\n]'), '_');
    final boundary = '----AgentRemote${DateTime.now().microsecondsSinceEpoch}';
    final preamble = utf8.encode(
      '--$boundary\r\n'
      'Content-Disposition: form-data; name="${provider.fieldName}"; '
      'filename="$safeName"\r\n'
      'Content-Type: application/octet-stream\r\n\r\n',
    );
    final epilogue = utf8.encode('\r\n--$boundary--\r\n');
    final total = preamble.length + size + epilogue.length;

    final client = HttpClient()
      ..connectionTimeout = const Duration(seconds: 30);
    try {
      final request = await client.postUrl(Uri.parse(provider.endpoint));
      request.headers.set(
        HttpHeaders.contentTypeHeader,
        'multipart/form-data; boundary=$boundary',
      );
      // Ask for an uncompressed response so the JSON/plain body parses as-is.
      request.headers.set(HttpHeaders.acceptEncodingHeader, 'identity');
      request.headers.set(
        HttpHeaders.userAgentHeader,
        'Mozilla/5.0 (AgentRemote)',
      );
      request.contentLength = total;

      request.add(preamble);
      var sent = preamble.length;
      onProgress?.call(total == 0 ? 1 : sent / total);

      final reader = await file.open();
      try {
        while (true) {
          final chunk = await reader.read(_chunkSize);
          if (chunk.isEmpty) break;
          request.add(chunk);
          sent += chunk.length;
          onProgress?.call((sent / total).clamp(0.0, 1.0));
          await request.flush();
        }
      } finally {
        await reader.close();
      }
      request.add(epilogue);

      final response = await request.close();
      final body = await response.transform(utf8.decoder).join();
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw RelayException(
          '${provider.label} 返回 ${response.statusCode}：${body.trim()}',
        );
      }
      final url = _parseUrl(provider, body);
      onProgress?.call(1);
      return RelayUploadResult(
        provider: provider,
        url: url,
        fileName: fileName,
        size: size,
      );
    } on RelayException {
      rethrow;
    } catch (error) {
      throw RelayException('上传失败：$error');
    } finally {
      client.close(force: true);
    }
  }

  static String _parseUrl(RelayProvider provider, String body) {
    switch (provider) {
      case RelayProvider.tmpfiles:
        final dynamic decoded = jsonDecode(body);
        final dynamic data =
            decoded is Map<String, dynamic> ? decoded['data'] : null;
        final dynamic raw = data is Map<String, dynamic> ? data['url'] : null;
        if (raw is! String || raw.isEmpty) {
          throw const RelayException('tmpfiles.org 未返回下载链接');
        }
        // The API returns a viewer URL; the raw file is served under /dl/.
        return raw.replaceFirst(
          'https://tmpfiles.org/',
          'https://tmpfiles.org/dl/',
        );
      case RelayProvider.uguu:
        final line = body
            .trim()
            .split('\n')
            .map((value) => value.trim())
            .firstWhere((value) => value.startsWith('http'), orElse: () => '');
        if (line.isEmpty) {
          throw const RelayException('uguu.se 未返回下载链接');
        }
        return line;
    }
  }

  static String _baseName(String path) {
    final normalized = path.replaceAll('\\', '/');
    final segments = normalized.split('/');
    return segments.isEmpty ? path : segments.last;
  }
}
