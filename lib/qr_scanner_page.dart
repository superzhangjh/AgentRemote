import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'cloudcli_address.dart';

class QrScannerPage extends StatefulWidget {
  const QrScannerPage({super.key});

  @override
  State<QrScannerPage> createState() => _QrScannerPageState();
}

class _QrScannerPageState extends State<QrScannerPage> {
  final scanner = MobileScannerController(formats: [BarcodeFormat.qrCode]);
  bool handled = false;
  String? error;

  @override
  void dispose() {
    scanner.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (handled) return;
    for (final barcode in capture.barcodes) {
      final value = barcode.rawValue;
      if (value == null) continue;
      try {
        final connection = parseCloudCliQrCode(value);
        handled = true;
        Navigator.of(context).pop(connection);
        return;
      } on FormatException catch (exception) {
        if (error != exception.message) {
          setState(() => error = exception.message);
        }
      }
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('扫描 CloudCLI 地址')),
    body: Stack(
      children: [
        MobileScanner(controller: scanner, onDetect: _onDetect),
        Align(
          alignment: Alignment.bottomCenter,
          child: Container(
            width: double.infinity,
            padding: const EdgeInsets.all(20),
            color: Colors.black.withValues(alpha: .75),
            child: Text(
              error ?? '扫描电脑端二维码，也支持本地或 Tailscale 地址。',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white),
            ),
          ),
        ),
      ],
    ),
  );
}
