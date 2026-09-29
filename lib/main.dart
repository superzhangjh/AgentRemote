import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'cloudcli_address.dart';
import 'desktop_console.dart';
import 'qr_scanner_page.dart';

void main() => runApp(
  Platform.isMacOS ? const DesktopConsoleApp() : const CloudCliRemoteApp(),
);

class CloudCliRemoteApp extends StatelessWidget {
  const CloudCliRemoteApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Agent 遥控台',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorSchemeSeed: const Color(0xFF8AE4C0),
    ),
    home: const CloudCliHomePage(),
  );
}

class CloudCliHomePage extends StatefulWidget {
  const CloudCliHomePage({super.key});

  @override
  State<CloudCliHomePage> createState() => _CloudCliHomePageState();
}

class _CloudCliHomePageState extends State<CloudCliHomePage>
    with WidgetsBindingObserver {
  static const _storage = MethodChannel('agent_remote/storage');
  static const _notifications = MethodChannel('agent_remote/notifications');
  static const _microphone = MethodChannel('agent_remote/microphone');
  final List<Uri> _addresses = [];
  Uri? _active;
  WebViewController? _web;
  Timer? _tokenTimer;
  String? _token;
  String? _pageError;
  bool _loading = true;
  bool _notificationsEnabled = false;
  bool _batteryUnrestricted = false;
  bool _syncingToken = false;
  int _addressGeneration = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    unawaited(_loadSaved());
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _tokenTimer?.cancel();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_syncToken());
      unawaited(_refreshBatteryStatus());
    }
  }

  Future<void> _loadSaved() async {
    try {
      final raw = await _storage.invokeMethod<String>('load');
      if (raw != null) {
        final saved = jsonDecode(raw) as Map<String, dynamic>;
        for (final value in (saved['addresses'] as List? ?? [])) {
          if (value is! String) continue;
          try {
            final uri = parseCloudCliAddress(value);
            if (!_addresses.contains(uri)) _addresses.add(uri);
          } on FormatException {
            // Ignore addresses saved by an older or malformed version.
          }
        }
        _notificationsEnabled = saved['notificationsEnabled'] == true;
        final preferred = saved['active'];
        if (preferred is String) {
          try {
            final uri = parseCloudCliAddress(preferred);
            if (_addresses.contains(uri)) _active = uri;
          } on FormatException {
            // Fall back to the latest valid address.
          }
        }
      }
    } catch (_) {
      // The connection screen remains usable if Android storage is unavailable.
    }
    if (!mounted) return;
    final initial = _active ?? (_addresses.isEmpty ? null : _addresses.first);
    setState(() => _loading = false);
    if (initial != null) await _selectAddress(initial, save: false);
    await _refreshBatteryStatus();
  }

  Future<void> _save() async {
    try {
      await _storage.invokeMethod<void>('save', {
        'value': jsonEncode({
          'active': _active?.toString(),
          'addresses': _addresses.map((address) => address.toString()).toList(),
          'notificationsEnabled': _notificationsEnabled,
        }),
      });
    } catch (_) {}
  }

  Future<void> _selectAddress(
    Uri address, {
    bool save = true,
    String? pairToken,
  }) async {
    final generation = ++_addressGeneration;
    var pairClaiming = false;
    var pairClaimed = false;
    _tokenTimer?.cancel();
    _token = null;
    if (_notificationsEnabled) {
      await _notifications.invokeMethod<void>('stop');
    }
    if (generation != _addressGeneration) return;
    _addresses.remove(address);
    _addresses.insert(0, address);
    final controller =
        WebViewController(
            onPermissionRequest: (request) async {
              if (request.types.length != 1 ||
                  !request.types.contains(
                    WebViewPermissionResourceType.microphone,
                  )) {
                await request.deny();
                return;
              }
              if (Platform.isAndroid) {
                final granted =
                    await _microphone
                        .invokeMethod<bool>('requestPermission')
                        .catchError((_) => false) ??
                    false;
                if (!granted) {
                  await request.deny();
                  return;
                }
              }
              await request.grant();
            },
          )
          ..setJavaScriptMode(JavaScriptMode.unrestricted)
          ..setBackgroundColor(const Color(0xFF111111))
          ..setNavigationDelegate(
            NavigationDelegate(
              onNavigationRequest: (request) {
                final target = Uri.tryParse(request.url);
                if (target == null) return NavigationDecision.prevent;
                if (target.origin == address.origin) {
                  return NavigationDecision.navigate;
                }
                if (target.scheme == 'http' || target.scheme == 'https') {
                  unawaited(
                    launchUrl(target, mode: LaunchMode.externalApplication),
                  );
                }
                return NavigationDecision.prevent;
              },
              onPageFinished: (_) {
                unawaited(_syncToken());
                if (pairToken != null &&
                    !pairClaiming &&
                    !pairClaimed &&
                    _pageError == null &&
                    generation == _addressGeneration) {
                  pairClaiming = true;
                  unawaited(
                    _claimPairing(address, pairToken).then((claimed) {
                      pairClaimed = claimed;
                      pairClaiming = false;
                    }),
                  );
                }
              },
              onWebResourceError: (error) {
                if (error.isForMainFrame == true && mounted) {
                  setState(() => _pageError = error.description);
                }
              },
            ),
          );
    if (!mounted || generation != _addressGeneration) return;
    setState(() {
      _active = address;
      _web = controller;
      _pageError = null;
    });
    await controller.loadRequest(address);
    if (generation != _addressGeneration) return;
    _tokenTimer = Timer.periodic(
      const Duration(seconds: 10),
      (_) => unawaited(_syncToken()),
    );
    if (save) unawaited(_save());
  }

  Future<bool> _claimPairing(Uri address, String token) async {
    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
    try {
      final request = await client.postUrl(
        address.resolve('/api/desktop-pairing/claim'),
      );
      request.headers.contentType = ContentType.json;
      request.write(jsonEncode({'token': token}));
      final response = await request.close();
      await response.drain<void>();
      return response.statusCode == HttpStatus.ok;
    } catch (_) {
      return false;
    } finally {
      client.close();
    }
  }

  Future<void> _syncToken() async {
    if (_syncingToken || _web == null || _active == null) return;
    _syncingToken = true;
    final controller = _web!;
    try {
      final result = await controller.runJavaScriptReturningResult(
        "localStorage.getItem('auth-token')",
      );
      if (controller != _web) return;
      String? next;
      if (result is String) {
        try {
          final decoded = jsonDecode(result);
          next = decoded is String ? decoded : null;
        } on FormatException {
          next = result;
        }
      }
      if (next != null && next.split('.').length != 3) next = null;
      if (next == _token) return;
      _token = next;
      if (!_notificationsEnabled) return;
      if (next == null) {
        await _notifications.invokeMethod<void>('stop');
      } else {
        await _startNotifications();
      }
    } catch (_) {
      // The login page has no token yet; the next page load or timer retries.
    } finally {
      _syncingToken = false;
    }
  }

  Future<void> _startNotifications() async {
    final address = _active;
    final token = _token;
    if (address == null || token == null) return;
    await _notifications.invokeMethod<void>('start', {
      'url': address.toString(),
      'token': token,
    });
  }

  Future<void> _toggleNotifications(bool enabled) async {
    if (enabled) {
      await _syncToken();
      if (_token == null) {
        _message('请先在 CloudCLI 中登录，再开启后台通知。');
        return;
      }
      final granted = await _notifications.invokeMethod<bool>(
        'requestPermission',
      );
      if (granted != true) {
        _message('请在系统设置中允许通知。');
        return;
      }
      await _startNotifications();
    } else {
      await _notifications.invokeMethod<void>('stop');
    }
    if (!mounted) return;
    setState(() => _notificationsEnabled = enabled);
    unawaited(_save());
  }

  Future<void> _refreshBatteryStatus() async {
    try {
      final ignored = await _notifications.invokeMethod<bool>(
        'batteryUnrestricted',
      );
      if (mounted) setState(() => _batteryUnrestricted = ignored == true);
    } catch (_) {}
  }

  void _message(String value) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(value)));
  }

  Future<void> _scan() async {
    final connection = await Navigator.of(context).push<CloudCliQrConnection>(
      MaterialPageRoute(builder: (_) => const QrScannerPage()),
    );
    if (connection != null) {
      await _selectAddress(connection.address, pairToken: connection.pairToken);
    }
  }

  Future<void> _addManually() async {
    final input = TextEditingController();
    final value = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('添加 CloudCLI 地址'),
        content: TextField(
          controller: input,
          autofocus: true,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(
            hintText: 'http://192.168.1.2:3001',
            helperText: 'Tailscale 可填写 HTTPS 域名或 100.x 地址',
          ),
          onSubmitted: (value) => Navigator.pop(context, value),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, input.text),
            child: const Text('连接'),
          ),
        ],
      ),
    );
    input.dispose();
    if (value == null) return;
    try {
      await _selectAddress(parseCloudCliAddress(value));
    } on FormatException catch (error) {
      _message(error.message);
    }
  }

  Future<void> _showAddresses() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, refreshSheet) => SafeArea(
          child: ListView(
            shrinkWrap: true,
            children: [
              const ListTile(title: Text('已保存的地址')),
              for (final address in _addresses)
                ListTile(
                  leading: Icon(
                    address == _active
                        ? Icons.radio_button_checked
                        : Icons.radio_button_off,
                  ),
                  title: Text(address.host),
                  subtitle: Text(address.toString()),
                  onTap: () {
                    Navigator.pop(context);
                    unawaited(_selectAddress(address));
                  },
                  trailing: IconButton(
                    tooltip: '移除地址',
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () {
                      final wasActive = address == _active;
                      setState(() => _addresses.remove(address));
                      refreshSheet(() {});
                      unawaited(_save());
                      if (wasActive) {
                        Navigator.pop(context);
                        final next = _addresses.isEmpty
                            ? null
                            : _addresses.first;
                        if (next == null) {
                          _tokenTimer?.cancel();
                          _web = null;
                          _active = null;
                          _token = null;
                          unawaited(_notifications.invokeMethod<void>('stop'));
                          setState(() {});
                          unawaited(_save());
                        } else {
                          unawaited(_selectAddress(next));
                        }
                      }
                    },
                  ),
                ),
              ListTile(
                leading: const Icon(Icons.qr_code_scanner),
                title: const Text('扫描二维码'),
                onTap: () {
                  Navigator.pop(context);
                  unawaited(_scan());
                },
              ),
              ListTile(
                leading: const Icon(Icons.add),
                title: const Text('手动添加'),
                onTap: () {
                  Navigator.pop(context);
                  unawaited(_addManually());
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _showSettings() async {
    await _refreshBatteryStatus();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (context) => StatefulBuilder(
        builder: (context, refreshSheet) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const ListTile(title: Text('后台与通知')),
              SwitchListTile(
                title: const Text('后台通知与常驻连接'),
                subtitle: const Text('显示常驻通知，锁屏后继续接收 Agent 消息'),
                value: _notificationsEnabled,
                onChanged: (value) async {
                  try {
                    await _toggleNotifications(value);
                    refreshSheet(() {});
                  } catch (error) {
                    _message('无法开启通知：$error');
                  }
                },
              ),
              ListTile(
                title: const Text('电池优化'),
                subtitle: Text(
                  _batteryUnrestricted ? '已允许后台持续运行' : '建议为本应用设置不受限制',
                ),
                trailing: const Icon(Icons.open_in_new),
                onTap: () => unawaited(
                  _notifications.invokeMethod<void>('openBatterySettings'),
                ),
              ),
              ListTile(
                title: const Text('系统通知权限'),
                trailing: const Icon(Icons.open_in_new),
                onTap: () => unawaited(
                  _notifications.invokeMethod<void>('openNotificationSettings'),
                ),
              ),
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 8, 16, 20),
                child: Text('通知只监听当前选中的地址；切换本地或 Tailscale 地址后会自动重连。'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: false,
    onPopInvokedWithResult: (didPop, _) async {
      if (didPop) return;
      if (await _web?.canGoBack() == true) {
        await _web?.goBack();
      } else {
        SystemNavigator.pop();
      }
    },
    child: Scaffold(
      appBar: AppBar(
        title: InkWell(
          onTap: _showAddresses,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: Text(
                  _active?.host ?? 'Agent 遥控台',
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              const Icon(Icons.arrow_drop_down),
            ],
          ),
        ),
        actions: [
          IconButton(
            tooltip: '扫描二维码',
            onPressed: _scan,
            icon: const Icon(Icons.qr_code_scanner),
          ),
          IconButton(
            tooltip: '后台设置',
            onPressed: _showSettings,
            icon: const Icon(Icons.notifications_outlined),
          ),
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : _active == null || _web == null
          ? Center(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.computer, size: 64),
                  const SizedBox(height: 16),
                  const Text('连接你的 CloudCLI 服务'),
                  const SizedBox(height: 20),
                  FilledButton.icon(
                    onPressed: _scan,
                    icon: const Icon(Icons.qr_code_scanner),
                    label: const Text('扫描二维码'),
                  ),
                  TextButton(
                    onPressed: _addManually,
                    child: const Text('手动输入地址'),
                  ),
                ],
              ),
            )
          : Stack(
              children: [
                WebViewWidget(key: ValueKey(_active), controller: _web!),
                if (_pageError != null)
                  Center(
                    child: Card(
                      child: Padding(
                        padding: const EdgeInsets.all(20),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Text('无法连接 CloudCLI'),
                            const SizedBox(height: 8),
                            Text(_pageError!),
                            TextButton(
                              onPressed: () {
                                setState(() => _pageError = null);
                                unawaited(_web!.reload());
                              },
                              child: const Text('重试'),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
    ),
  );
}
