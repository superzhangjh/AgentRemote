/// Accepts a CloudCLI server origin from a QR code or manual entry.
Uri parseCloudCliAddress(String input) {
  final text = input.trim();
  if (text.isEmpty) throw const FormatException('请输入服务地址');
  final uri = Uri.tryParse(text.contains('://') ? text : 'http://$text');
  if (uri == null ||
      (uri.scheme != 'http' && uri.scheme != 'https') ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      (uri.path.isNotEmpty && uri.path != '/') ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.hasPort && uri.port == 0)) {
    throw const FormatException(
      '请输入 CloudCLI 地址，例如 http://192.168.1.2:3001 或 https://mac.tailnet.ts.net',
    );
  }
  return uri.replace(path: '', query: null, fragment: null);
}

class CloudCliQrConnection {
  const CloudCliQrConnection(this.address, this.pairToken);

  final Uri address;
  final String? pairToken;
}

/// QR codes may carry a one-time pairing token; saved addresses never do.
CloudCliQrConnection parseCloudCliQrCode(String input) {
  final uri = Uri.tryParse(input.trim());
  if (uri == null ||
      uri.queryParameters.length > 1 ||
      uri.fragment.isNotEmpty) {
    throw const FormatException('二维码地址无效');
  }
  final token = uri.queryParameters['pair'];
  if (uri.hasQuery &&
      (uri.queryParametersAll['pair']?.length != 1 ||
          token == null ||
          !RegExp(r'^[a-f0-9]{32}$').hasMatch(token))) {
    throw const FormatException('配对二维码无效或已过期');
  }
  return CloudCliQrConnection(
    parseCloudCliAddress(input.trim().split('?').first),
    token,
  );
}
