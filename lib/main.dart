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

const _defaultStatusBarColor = Color(0xFF141414);

const _systemUiOverlayStyle = SystemUiOverlayStyle(
  statusBarColor: _defaultStatusBarColor,
  statusBarIconBrightness: Brightness.light,
  statusBarBrightness: Brightness.dark,
  systemNavigationBarColor: Colors.transparent,
  systemNavigationBarIconBrightness: Brightness.light,
  systemNavigationBarDividerColor: Colors.transparent,
);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  if (!Platform.isMacOS) {
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    SystemChrome.setSystemUIOverlayStyle(_systemUiOverlayStyle);
  }
  runApp(
    Platform.isMacOS ? const DesktopConsoleApp() : const CloudCliRemoteApp(),
  );
}

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
      scaffoldBackgroundColor: const Color(0xFF111111),
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
  static const _speech = MethodChannel('agent_remote/speech');
  static const _shake = MethodChannel('agent_remote/shake');
  final List<Uri> _addresses = [];
  bool _modalOpen = false;
  Uri? _active;
  WebViewController? _web;
  Timer? _tokenTimer;
  Timer? _visibleSessionTimer;
  String? _token;
  String? _visibleSessionId;
  String? _pageError;
  bool _webReady = false;
  bool _pageLoading = false;
  int _pageProgress = 0;
  Timer? _pageWatchdog;
  bool _loading = true;
  bool _notificationsEnabled = false;
  bool _batteryUnrestricted = false;
  bool _syncingToken = false;
  bool _syncingVisibleSession = false;
  int _addressGeneration = 0;
  Color _statusBarColor = _defaultStatusBarColor;
  Map<String, dynamic>? _pendingNotificationTarget;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _notifications.setMethodCallHandler(_handleNativeNotification);
    unawaited(_consumePendingNotification());
    _speech.setMethodCallHandler(_handleSpeechEvent);
    _shake.setMethodCallHandler(_handleShake);
    unawaited(_startShakeDetection());
    unawaited(_loadSaved());
  }

  Future<void> _handleShake(MethodCall call) async {
    if (call.method == 'onShake') unawaited(_showControlPanel());
  }

  /// Forwards a native on-device recognition event to the CloudCLI page, which
  /// exposes `AgentRemoteVoiceBridge.dispatch` while its composer is mounted.
  Future<void> _handleSpeechEvent(MethodCall call) async {
    if (call.method != 'event') return;
    final arguments = call.arguments;
    if (arguments is! Map) return;
    await _dispatchNativeVoice(Map<String, dynamic>.from(arguments));
  }

  Future<void> _dispatchNativeVoice(Map<String, dynamic> event) async {
    final controller = _web;
    if (controller == null || !_webReady) return;
    try {
      await controller.runJavaScript(
        'window.AgentRemoteVoiceBridge && '
        'window.AgentRemoteVoiceBridge.dispatch(${jsonEncode(event)});',
      );
    } catch (_) {}
  }

  /// Handles messages posted through the injected `AgentRemoteVoice` JavaScript
  /// channel: the page asks the shell to start or stop on-device dictation.
  Future<void> _handleVoiceBridgeMessage(String message) async {
    try {
      final data = jsonDecode(message);
      if (data is! Map) return;
      switch (data['action']) {
        case 'start':
          final granted =
              await _microphone
                  .invokeMethod<bool>('requestPermission')
                  .catchError((_) => false) ??
              false;
          if (!granted) {
            await _dispatchNativeVoice(const {
              'type': 'error',
              'message': '未授予录音权限',
            });
            return;
          }
          final language = data['language'];
          await _speech.invokeMethod<void>('start', {
            if (language is String && language.isNotEmpty) 'language': language,
          });
        case 'stop':
          await _speech.invokeMethod<void>('stop');
        case 'cancel':
          await _speech.invokeMethod<void>('cancel');
      }
    } catch (error) {
      await _dispatchNativeVoice({'type': 'error', 'message': '$error'});
    }
  }

  Future<void> _handleNativeNotification(MethodCall call) async {
    if (call.method != 'notificationTapped') return;
    await _openNotificationTarget(
      Map<String, dynamic>.from(call.arguments as Map),
    );
  }

  Future<void> _consumePendingNotification() async {
    try {
      final target = await _notifications.invokeMapMethod<String, dynamic>(
        'takePendingNotification',
      );
      if (target != null) await _openNotificationTarget(target);
    } catch (_) {}
  }

  Future<void> _openNotificationTarget(Map<String, dynamic> target) async {
    final sessionId = target['sessionId'];
    if (sessionId is! String || sessionId.isEmpty) return;

    final address = _active;
    final controller = _web;
    if (address == null || controller == null) {
      _pendingNotificationTarget = target;
      return;
    }

    final provider = target['provider'];
    final sessionUri = address.resolve(
      '/session/${Uri.encodeComponent(sessionId)}',
    );
    final notificationProvider = const {'claude', 'cursor', 'codex', 'opencode'};
    final targetUri = provider is String && notificationProvider.contains(provider)
        ? sessionUri.replace(queryParameters: {'notificationProvider': provider})
        : sessionUri;

    if (_pendingNotificationTarget?['sessionId'] == sessionId) {
      _pendingNotificationTarget = null;
    }
    try {
      if (!await _navigateWithinSpa(controller, address, targetUri)) {
        await controller.loadRequest(targetUri);
      }
      await _notifications.invokeMethod<void>('acknowledgeNotification', {
        'sessionId': sessionId,
        'provider': target['provider'],
      });
    } catch (_) {
      _pendingNotificationTarget = target;
    }
  }

  /// Switches sessions through the CloudCLI React Router instead of reloading
  /// the whole single-page app. Returns false when an in-place navigation is not
  /// possible yet (for example before the first page has finished loading).
  Future<bool> _navigateWithinSpa(
    WebViewController controller,
    Uri address,
    Uri target,
  ) async {
    if (!_webReady || _pageError != null) return false;
    try {
      final currentUrl = await controller.currentUrl();
      final current = currentUrl == null ? null : Uri.tryParse(currentUrl);
      if (current == null || current.origin != address.origin) return false;
      final destination = '${target.path}${target.hasQuery ? '?${target.query}' : ''}';
      final result = await controller.runJavaScriptReturningResult('''
(function () {
  try {
    var destination = ${jsonEncode(destination)};
    if (window.location.pathname + window.location.search === destination) return true;
    var state = Object.assign({}, window.history.state || {});
    state.idx = (typeof state.idx === 'number' ? state.idx : 0) + 1;
    state.key = Math.random().toString(36).slice(2);
    window.history.pushState(state, '', destination);
    window.dispatchEvent(new PopStateEvent('popstate', { state: state }));
    return true;
  } catch (e) {
    return false;
  }
})();
''');
      return result == true || result == 'true';
    } catch (_) {
      return false;
    }
  }

  void _startPageWatchdog(int generation) {
    _pageWatchdog?.cancel();
    _pageWatchdog = Timer(const Duration(seconds: 45), () {
      if (!mounted || generation != _addressGeneration) return;
      if (!_pageLoading || _pageError != null) return;
      setState(() {
        _pageLoading = false;
        _pageError = '连接超时，请检查网络或地址后重试。';
      });
    });
  }

  Future<void> _startShakeDetection() async {
    if (!Platform.isAndroid) return;
    try {
      await _shake.invokeMethod<void>('start');
    } catch (_) {}
  }

  Future<void> _stopShakeDetection() async {
    if (!Platform.isAndroid) return;
    try {
      await _shake.invokeMethod<void>('stop');
    } catch (_) {}
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _tokenTimer?.cancel();
    _visibleSessionTimer?.cancel();
    _pageWatchdog?.cancel();
    unawaited(_stopShakeDetection());
    _shake.setMethodCallHandler(null);
    _speech.setMethodCallHandler(null);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_startShakeDetection());
      _startVisibleSessionTracking();
      unawaited(_syncToken());
      unawaited(_notifyWebResume());
      unawaited(_refreshBatteryStatus());
    } else {
      unawaited(_stopShakeDetection());
      _stopVisibleSessionTracking();
    }
  }

  void _startVisibleSessionTracking() {
    _visibleSessionTimer?.cancel();
    unawaited(_syncVisibleSession());
    _visibleSessionTimer = Timer.periodic(
      const Duration(seconds: 1),
      (_) => unawaited(_syncVisibleSession()),
    );
  }

  void _stopVisibleSessionTracking() {
    _visibleSessionTimer?.cancel();
    _visibleSessionTimer = null;
    _visibleSessionId = null;
    unawaited(_setVisibleSession(''));
  }

  Future<void> _setVisibleSession(String sessionId) async {
    try {
      await _notifications.invokeMethod<void>('setVisibleSession', {
        'sessionId': sessionId,
      });
    } catch (_) {}
  }

  Future<void> _syncVisibleSession() async {
    final controller = _web;
    if (_syncingVisibleSession ||
        controller == null ||
        WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed) {
      return;
    }

    _syncingVisibleSession = true;
    try {
      final url = await controller.currentUrl();
      if (!mounted ||
          controller != _web ||
          WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed) {
        return;
      }
      final segments =
          Uri.tryParse(url ?? '')?.pathSegments ?? const <String>[];
      final sessionIndex = segments.indexOf('session');
      final sessionId = sessionIndex >= 0 && sessionIndex + 1 < segments.length
          ? segments[sessionIndex + 1]
          : '';
      if (sessionId == _visibleSessionId) return;
      _visibleSessionId = sessionId;
      await _setVisibleSession(sessionId);
    } catch (_) {
      // The WebView may not have a URL yet; the next poll will retry.
    } finally {
      _syncingVisibleSession = false;
    }
  }

  Future<void> _confirmFileDownload(String message) async {
    try {
      final payload = jsonDecode(message) as Map<String, dynamic>;
      final rawUrl = payload['url'];
      final rawFileName = payload['fileName'];
      final baseUrl = _active;
      final controller = _web;
      final generation = _addressGeneration;
      if (rawUrl is! String ||
          rawFileName is! String ||
          baseUrl == null ||
          controller == null) {
        return;
      }

      final fileName = rawFileName.trim();
      final downloadUrl = baseUrl.resolve(rawUrl);
      if (fileName.isEmpty ||
          downloadUrl.origin != baseUrl.origin ||
          !['http', 'https'].contains(downloadUrl.scheme)) {
        _message('下载地址无效。');
        return;
      }

      final confirmed = await showDialog<bool>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('下载文件？'),
          content: Text('是否下载“$fileName”？文件会保存到“下载”文件夹。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('下载'),
            ),
          ],
        ),
      );
      if (confirmed != true ||
          !mounted ||
          _active != baseUrl ||
          _web != controller ||
          _addressGeneration != generation) {
        return;
      }

      await _syncToken();
      if (!mounted ||
          _active != baseUrl ||
          _web != controller ||
          _addressGeneration != generation) {
        return;
      }
      final token = _token;
      if (token == null) {
        _message('请先在 CloudCLI 中登录。');
        return;
      }

      await _notifications.invokeMethod<int>('enqueueDownload', {
        'url': downloadUrl.toString(),
        'baseUrl': baseUrl.toString(),
        'fileName': fileName,
        'mimeType': payload['mimeType'] is String ? payload['mimeType'] : '',
        'token': token,
      });
      if (mounted) _message('已开始下载：$fileName');
    } catch (error) {
      if (mounted) _message('无法开始下载：$error');
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

  SystemUiOverlayStyle get _overlayStyle {
    final isBright = _statusBarColor.computeLuminance() > 0.5;
    return SystemUiOverlayStyle(
      statusBarColor: _statusBarColor,
      statusBarIconBrightness: isBright ? Brightness.dark : Brightness.light,
      statusBarBrightness: isBright ? Brightness.light : Brightness.dark,
      systemNavigationBarColor: Colors.transparent,
      systemNavigationBarIconBrightness: Brightness.light,
      systemNavigationBarDividerColor: Colors.transparent,
    );
  }

  static const _themeWatcherScript = r'''
(function () {
  function post() {
    try {
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta && meta.content && window.AgentRemoteTheme) {
        window.AgentRemoteTheme.postMessage(String(meta.content));
      }
    } catch (e) {}
  }
  try {
    if (!window.__agentRemoteThemeWatching) {
      window.__agentRemoteThemeWatching = true;
      var meta = document.querySelector('meta[name="theme-color"]');
      if (meta && window.MutationObserver) {
        new MutationObserver(post).observe(meta, {
          attributes: true,
          attributeFilter: ['content'],
        });
      }
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq && mq.addEventListener) {
        mq.addEventListener('change', function () { setTimeout(post, 80); });
      }
    }
  } catch (e) {}
  post();
})();
''';

  Future<void> _installThemeWatcher() async {
    final controller = _web;
    if (controller == null) return;
    try {
      await controller.runJavaScript(_themeWatcherScript);
    } catch (_) {}
  }

  void _applyThemeColor(String raw) {
    final color = _parseCssColor(raw);
    if (color == null || color == _statusBarColor || !mounted) return;
    setState(() => _statusBarColor = color);
  }

  static Color? _parseCssColor(String value) {
    final text = value.trim().toLowerCase();
    if (text.startsWith('#')) {
      var hex = text.substring(1);
      if (hex.length == 3) {
        hex = hex.split('').map((char) => '$char$char').join();
      }
      if (hex.length == 6) {
        final parsed = int.tryParse(hex, radix: 16);
        if (parsed != null) return Color(0xFF000000 | parsed);
      } else if (hex.length == 8) {
        final parsed = int.tryParse(hex, radix: 16);
        if (parsed != null) return Color(parsed);
      }
      return null;
    }
    final match = RegExp(r'rgba?\(([^)]+)\)').firstMatch(text);
    if (match != null) {
      final parts = match.group(1)!.split(',').map((part) => part.trim());
      final channels = parts.take(3).map(int.tryParse).toList();
      if (channels.length == 3 && !channels.contains(null)) {
        return Color.fromARGB(
          255,
          channels[0]!.clamp(0, 255).toInt(),
          channels[1]!.clamp(0, 255).toInt(),
          channels[2]!.clamp(0, 255).toInt(),
        );
      }
    }
    return null;
  }

  Future<void> _selectAddress(
    Uri address, {
    bool save = true,
    String? pairToken,
  }) async {
    final generation = ++_addressGeneration;
    _stopVisibleSessionTracking();
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
              onPageStarted: (_) {
                if (generation != _addressGeneration || !mounted) return;
                setState(() {
                  _pageLoading = true;
                  _pageProgress = 0;
                });
                _startPageWatchdog(generation);
              },
              onProgress: (progress) {
                if (generation != _addressGeneration ||
                    !mounted ||
                    progress == _pageProgress) {
                  return;
                }
                setState(() => _pageProgress = progress);
              },
              onPageFinished: (_) {
                if (generation == _addressGeneration) {
                  _webReady = true;
                  _pageWatchdog?.cancel();
                }
                if (mounted) setState(() => _pageLoading = false);
                unawaited(_syncToken());
                unawaited(_syncVisibleSession());
                unawaited(_installThemeWatcher());
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
                  _pageWatchdog?.cancel();
                  setState(() {
                    _pageLoading = false;
                    _pageError = error.description;
                  });
                }
              },
            ),
          );
    if (Platform.isAndroid) {
      await controller.addJavaScriptChannel(
        'AgentRemoteDownload',
        onMessageReceived: (message) =>
            unawaited(_confirmFileDownload(message.message)),
      );
      // Only expose the voice bridge when the device actually has a speech
      // recognition service, so CloudCLI hides the mic button instead of
      // failing on devices without one.
      var speechAvailable = false;
      try {
        speechAvailable =
            await _speech.invokeMethod<bool>('isAvailable') ?? false;
      } catch (_) {}
      if (speechAvailable) {
        await controller.addJavaScriptChannel(
          'AgentRemoteVoice',
          onMessageReceived: (message) =>
              unawaited(_handleVoiceBridgeMessage(message.message)),
        );
      }
    }
    await controller.addJavaScriptChannel(
      'AgentRemoteTheme',
      onMessageReceived: (message) => _applyThemeColor(message.message),
    );
    if (!mounted || generation != _addressGeneration) return;
    setState(() {
      _active = address;
      _web = controller;
      _pageError = null;
      _webReady = false;
      _pageLoading = true;
      _pageProgress = 0;
    });
    _startPageWatchdog(generation);
    await controller.loadRequest(address);
    if (generation != _addressGeneration) return;
    final pendingNotification = _pendingNotificationTarget;
    if (pendingNotification != null) {
      _pendingNotificationTarget = null;
      await _openNotificationTarget(pendingNotification);
      if (generation != _addressGeneration) return;
    }
    if (WidgetsBinding.instance.lifecycleState == AppLifecycleState.resumed) {
      _startVisibleSessionTracking();
    }
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

  /// Tells the CloudCLI page it has been resumed so it can reconcile its
  /// sidebar without a manual refresh. The Android activity returning to the
  /// foreground does not reliably emit `visibilitychange` inside the WebView,
  /// so the shell dispatches an explicit event the page listens for.
  Future<void> _notifyWebResume() async {
    final controller = _web;
    if (controller == null || !_webReady) return;
    try {
      await controller.runJavaScript(
        "window.dispatchEvent(new Event('agentremote:resume'));",
      );
    } catch (_) {}
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
    if (_modalOpen) return;
    _modalOpen = true;
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
    _modalOpen = false;
  }

  Future<void> _showSettings() async {
    if (_modalOpen) return;
    _modalOpen = true;
    await _refreshBatteryStatus();
    if (!mounted) {
      _modalOpen = false;
      return;
    }
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
                subtitle: const Text('常驻通知静默显示，锁屏后继续接收；仅完成与审批时弹出提醒'),
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
    _modalOpen = false;
  }

  Future<void> _showControlPanel() async {
    if (_modalOpen || !mounted) return;
    final route = ModalRoute.of(context);
    if (route != null && !route.isCurrent) return;
    _modalOpen = true;
    _PanelAction? action;
    try {
      action = await showModalBottomSheet<_PanelAction>(
        context: context,
        isScrollControlled: true,
        builder: (context) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const ListTile(
                leading: Icon(Icons.vibration),
                title: Text('摇一摇控制台'),
                subtitle: Text('选择要执行的操作'),
              ),
              const Divider(height: 1),
              ListTile(
                leading: const Icon(Icons.dns_outlined),
                title: const Text('切换服务器'),
                subtitle: Text(_active?.host ?? '未连接'),
                onTap: () => Navigator.pop(context, _PanelAction.switchServer),
              ),
              ListTile(
                leading: const Icon(Icons.qr_code_scanner),
                title: const Text('扫描二维码'),
                onTap: () => Navigator.pop(context, _PanelAction.scan),
              ),
              ListTile(
                leading: const Icon(Icons.add_link),
                title: const Text('手动添加地址'),
                onTap: () => Navigator.pop(context, _PanelAction.addManually),
              ),
              ListTile(
                leading: const Icon(Icons.notifications_outlined),
                title: const Text('后台与通知'),
                subtitle: Text(_notificationsEnabled ? '已开启' : '未开启'),
                onTap: () => Navigator.pop(context, _PanelAction.settings),
              ),
            ],
          ),
        ),
      );
    } finally {
      _modalOpen = false;
    }
    if (!mounted) return;
    await Future<void>.delayed(Duration.zero);
    switch (action) {
      case _PanelAction.switchServer:
        await _showAddresses();
      case _PanelAction.scan:
        await _scan();
      case _PanelAction.addManually:
        await _addManually();
      case _PanelAction.settings:
        await _showSettings();
      case null:
        break;
    }
  }

  @override
  Widget build(BuildContext context) => AnnotatedRegion<SystemUiOverlayStyle>(
    value: _overlayStyle,
    child: PopScope(
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
        body: Column(
          children: [
            Container(
              height: MediaQuery.paddingOf(context).top,
              color: _statusBarColor,
            ),
            Expanded(
              child: SafeArea(
                top: false,
                child: _loading
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
                          WebViewWidget(
                            key: ValueKey(_active),
                            controller: _web!,
                          ),
                          if (_pageLoading && _pageError == null)
                            Positioned.fill(
                              child: ColoredBox(
                                color: const Color(0xFF111111),
                                child: Center(
                                  child: Column(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      SizedBox(
                                        width: 44,
                                        height: 44,
                                        child: CircularProgressIndicator(
                                          value: _pageProgress > 0
                                              ? _pageProgress / 100
                                              : null,
                                        ),
                                      ),
                                      const SizedBox(height: 16),
                                      Text('正在连接 ${_active?.host ?? ''}'),
                                      if (_pageProgress > 0) ...[
                                        const SizedBox(height: 6),
                                        Text('$_pageProgress%'),
                                      ],
                                      const SizedBox(height: 12),
                                      TextButton(
                                        onPressed: () =>
                                            unawaited(_showAddresses()),
                                        child: const Text('切换服务器'),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
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
                                      const SizedBox(height: 8),
                                      Wrap(
                                        spacing: 8,
                                        children: [
                                          TextButton(
                                            onPressed: () {
                                              setState(() {
                                                _pageError = null;
                                                _pageLoading = true;
                                                _pageProgress = 0;
                                              });
                                              _startPageWatchdog(
                                                _addressGeneration,
                                              );
                                              unawaited(_web!.reload());
                                            },
                                            child: const Text('重试'),
                                          ),
                                          TextButton(
                                            onPressed: () =>
                                                unawaited(_showAddresses()),
                                            child: const Text('切换服务器'),
                                          ),
                                        ],
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                        ],
                      ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}

enum _PanelAction { switchServer, scan, addManually, settings }
