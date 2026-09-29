import 'package:agent_remote/cloudcli_address.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('accepts local and Tailscale server origins', () {
    expect(
      parseCloudCliAddress('192.168.1.8:3001').toString(),
      'http://192.168.1.8:3001',
    );
    expect(
      parseCloudCliAddress('http://100.101.102.103:3001/').toString(),
      'http://100.101.102.103:3001',
    );
    expect(
      parseCloudCliAddress('https://mac.example.ts.net').toString(),
      'https://mac.example.ts.net',
    );
  });

  test('rejects credentials and links to other pages', () {
    expect(
      () => parseCloudCliAddress('http://user:pass@host:3001'),
      throwsFormatException,
    );
    expect(
      () => parseCloudCliAddress('https://host.example/session/123'),
      throwsFormatException,
    );
    expect(
      () => parseCloudCliAddress('https://host.example/?token=secret'),
      throwsFormatException,
    );
  });

  test('reads a one-time pairing token without saving it in the address', () {
    const token = '0123456789abcdef0123456789abcdef';
    final connection = parseCloudCliQrCode(
      'http://192.168.1.8:3001?pair=$token',
    );
    expect(connection.address.toString(), 'http://192.168.1.8:3001');
    expect(connection.pairToken, token);
    expect(
      () => parseCloudCliQrCode('http://host:3001?pair=bad'),
      throwsFormatException,
    );
    expect(
      () => parseCloudCliQrCode('http://host:3001?pair=$token&pair=$token'),
      throwsFormatException,
    );
  });
}
