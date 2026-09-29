import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

const _serviceLabel = 'dev.agentremote.cloudcli';

class DesktopConsoleApp extends StatelessWidget {
  const DesktopConsoleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Agent 遥控台电脑服务',
        debugShowCheckedModeBanner: false,
        theme: ThemeData(useMaterial3: true, brightness: Brightness.dark),
        home: const _DesktopConsolePage(),
      );
}

class _DesktopConsolePage extends StatefulWidget {
  const _DesktopConsolePage();

  @override
  State<_DesktopConsolePage> createState() => _DesktopConsolePageState();
}

class _DesktopConsolePageState extends State<_DesktopConsolePage> {
  static const _consoleChannel = MethodChannel('agent_remote/console');
  List<String> addresses = [];
  String? selectedAddress;
  String? _configuredCloudCliPath;
  String status = '正在检查服务…';
  bool running = false;
  bool _launchAgentManaged = false;
  bool busy = false;
  bool pairingBusy = false;
  // Prevents duplicate checks while macOS is handling a local-network prompt.
  bool permissionBusy = false;
  String? _pairToken;
  Uri? _pairAddress;
  Timer? _pairTimer;
  bool _pollingPair = false;

  String get _home => Platform.environment['HOME'] ?? '';
  String get _plistPath => '$_home/Library/LaunchAgents/$_serviceLabel.plist';
  String get _consoleConfigPath =>
      '$_home/Library/Application Support/AgentRemote/desktop-console.json';
  String get _tailscalePath => '/usr/local/bin/tailscale';
  String get _cloudCliPath => _configuredCloudCliPath ?? '';
  String get _bundledCloudCliPath =>
      '$_consoleAppPath/Contents/Resources/cloudcli';
  String get _managedCloudCliPath =>
      '$_home/Library/Application Support/AgentRemote/cloudcli-runtime';
  late final String _nodePath = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    for (final directory in (Platform.environment['PATH'] ?? '').split(':'))
      if (directory.isNotEmpty) '$directory/node',
  ].firstWhere((path) => File(path).existsSync(), orElse: () => 'node');
  String get _nodePermissionPath {
    try {
      return File(_nodePath).resolveSymbolicLinksSync();
    } catch (_) {
      return _nodePath;
    }
  }

  String get _consoleAppPath {
    var directory = File(Platform.resolvedExecutable).parent;
    while (directory.parent.path != directory.path) {
      if (directory.path.endsWith('.app')) return directory.path;
      directory = directory.parent;
    }
    return Platform.resolvedExecutable;
  }

  Future<void> _openFileAccessSettings() async {
    await Process.run('/usr/bin/open', [
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
    ]);
  }

  Future<void> _openLocalNetworkSettings() async {
    await Process.run('/usr/bin/open', [
      'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork',
    ]);
  }

  Future<void> _openFirewallSettings() async {
    await Process.run('/usr/bin/open', ['-a', 'System Settings']);
  }

  Future<void> _revealInFinder(String path) async {
    await Process.run('/usr/bin/open', ['-R', path]);
  }

  Future<void> _prepareRemoteAccess() async {
    if (permissionBusy || selectedAddress == null) return;
    setState(() => permissionBusy = true);
    if (!running) await _start();
    var networkReady = false;
    if (running && selectedAddress != null) {
      final client = _directHttpClient(const Duration(seconds: 5));
      try {
        final request = await client.getUrl(
          Uri.parse('http://$selectedAddress:3001/health'),
        );
        final response = await request.close();
        networkReady = response.statusCode == HttpStatus.ok;
        await response.drain<void>();
      } catch (_) {
        // The dialog below gives the user the relevant macOS settings to check.
      } finally {
        client.close();
      }
    }
    if (!mounted) return;
    setState(() => permissionBusy = false);
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('远程使用准备'),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                networkReady
                    ? '✓ 已通过所选地址连接后台服务'
                    : '⚠ 无法通过所选地址连接后台服务；请检查局域网权限和服务状态',
              ),
              const SizedBox(height: 12),
              const Text(
                '文件：在完整磁盘访问中点“+”添加控制台和下方 Node 程序。若应用列表里找不到，请在文件选择窗口按 Command-Shift-G 并粘贴显示的路径。',
              ),
              const SizedBox(height: 8),
              Text('控制台：\n$_consoleAppPath'),
              TextButton.icon(
                onPressed: () => unawaited(_revealInFinder(_consoleAppPath)),
                icon: const Icon(Icons.folder_open_outlined),
                label: const Text('在 Finder 中定位控制台应用'),
              ),
              Text('后台 Node：\n$_nodePermissionPath'),
              TextButton.icon(
                onPressed: () =>
                    unawaited(_revealInFinder(_nodePermissionPath)),
                icon: const Icon(Icons.folder_open_outlined),
                label: const Text('在 Finder 中定位 Node'),
              ),
              const SizedBox(height: 12),
              const Text(
                '本地网络列表只会显示已经发起局域网请求的应用。点“检查并准备远程权限”触发请求并允许弹窗；若探测成功但列表没有控制台，无需再添加。防火墙若拦截，请在系统设置 → 网络 → 防火墙中添加 Node。离开 Mac 前用手机连接一次，以触发可能的入站提示。',
              ),
              const SizedBox(height: 8),
              const Text('完成授权后，停止并重新启动后台服务。其他 Agent 自身弹出的权限仍需分别授权。'),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => unawaited(_openFileAccessSettings()),
            child: const Text('文件权限'),
          ),
          TextButton(
            onPressed: () => unawaited(_openLocalNetworkSettings()),
            child: const Text('本地网络'),
          ),
          TextButton(
            onPressed: () => unawaited(_openFirewallSettings()),
            child: const Text('防火墙'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('完成'),
          ),
        ],
      ),
    );
  }

  Future<void> _chooseCloudCliDirectory() async {
    final selectedPath = await _consoleChannel.invokeMethod<String>(
      'chooseCloudCliDirectory',
      {'initialPath': _cloudCliPath.isNotEmpty ? _cloudCliPath : _home},
    );
    if (selectedPath == null || !mounted) return;
    final resolvedPath = _resolveCloudCliDirectory(selectedPath);
    if (resolvedPath == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('请选择 CloudCLI 文件夹或其上层项目文件夹')),
      );
      return;
    }
    await _saveCloudCliPath(resolvedPath);
  }

  Future<void> _saveCloudCliPath(String path) async {
    try {
      final config = File(_consoleConfigPath);
      await config.parent.create(recursive: true);
      await config.writeAsString(jsonEncode({'cloudCliPath': path}));
      if (mounted) {
        setState(() {
          _configuredCloudCliPath = path;
          status = running ? '目录已保存；请停止并重新启动后台服务以应用新路径' : 'CloudCLI 项目目录已保存';
        });
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('无法保存 CloudCLI 目录：$error')));
      }
    }
  }

  String? _resolveCloudCliDirectory(String path) {
    final selected = Directory(path);
    if (_isCloudCliDirectory(selected)) return selected.absolute.path;
    final nested = Directory('${selected.path}/cloudcli');
    return _isCloudCliDirectory(nested) ? nested.absolute.path : null;
  }

  String _cloudCliEntry(String path) =>
      '$path/dist-server/server/modules/cli/cli.js';

  HttpClient _directHttpClient(Duration timeout) => HttpClient()
    ..connectionTimeout = timeout
    ..findProxy = (_) => 'DIRECT';

  bool _isCloudCliDirectory(Directory directory) =>
      File('${directory.path}/package.json').existsSync() &&
      (File(_cloudCliEntry(directory.path)).existsSync() ||
          File('${directory.path}/server/modules/cli/cli.service.ts')
              .existsSync());

  bool _hasBuiltCloudCli(String path) =>
      File(_cloudCliEntry(path)).existsSync();

  Future<bool> _hasLiveCloudCliServer() async {
    try {
      final marker = jsonDecode(
        await File('$_home/.cloudcli/local-server.json').readAsString(),
      ) as Map<String, dynamic>;
      final pid = marker['pid'];
      final appRoot = marker['appRoot'];
      if (pid is! int || marker['port'] != 3001 || appRoot is! String) {
        return false;
      }
      final process = await Process.run('/bin/ps', [
        '-p',
        '$pid',
        '-o',
        'command=',
      ]);
      final command = (process.stdout as String).trim();
      return process.exitCode == 0 &&
          command.contains('cli.js') &&
          command.contains(appRoot);
    } catch (_) {
      return false;
    }
  }

  String? _findInstalledCloudCliPath() {
    final candidates = <String>{
      '/opt/homebrew/bin/cloudcli',
      '/usr/local/bin/cloudcli',
      for (final directory in (Platform.environment['PATH'] ?? '').split(':'))
        if (directory.isNotEmpty) '$directory/cloudcli',
      '/opt/homebrew/lib/node_modules/@cloudcli-ai/cloudcli',
      '/usr/local/lib/node_modules/@cloudcli-ai/cloudcli',
      '$_home/.npm-global/lib/node_modules/@cloudcli-ai/cloudcli',
    };
    for (final candidate in candidates) {
      try {
        final file = File(candidate);
        if (file.existsSync()) {
          var directory = Directory(file.resolveSymbolicLinksSync()).parent;
          while (true) {
            if (_hasBuiltCloudCli(directory.path) &&
                File('${directory.path}/package.json').existsSync()) {
              return directory.path;
            }
            if (directory.parent.path == directory.path) break;
            directory = directory.parent;
          }
        }
        final directory = Directory(candidate);
        if (_isCloudCliDirectory(directory) &&
            _hasBuiltCloudCli(directory.path)) {
          return directory.path;
        }
      } catch (_) {
        // A stale PATH entry or broken symlink is not a usable installation.
      }
    }
    return null;
  }

  String _findCloudCliPath() {
    if (_isCloudCliDirectory(Directory(_bundledCloudCliPath))) {
      return _bundledCloudCliPath;
    }
    String? sourcePath;
    for (final start in [
      Platform.environment['AGENT_REMOTE_PROJECT_ROOT'],
      Directory.current.path,
      File(Platform.resolvedExecutable).parent.path,
    ]) {
      if (start == null || start.isEmpty) continue;
      var directory = Directory(start);
      while (true) {
        if (_isCloudCliDirectory(directory)) {
          if (_hasBuiltCloudCli(directory.path)) return directory.path;
          sourcePath ??= directory.path;
        }
        final candidate = Directory('${directory.path}/cloudcli');
        if (_isCloudCliDirectory(candidate)) {
          if (_hasBuiltCloudCli(candidate.path)) return candidate.path;
          sourcePath ??= candidate.path;
        }
        if (directory.parent.path == directory.path) break;
        directory = directory.parent;
      }
    }
    return sourcePath ?? _findInstalledCloudCliPath() ?? '';
  }

  String get _npmPath => [
        '${File(_nodePath).parent.path}/npm',
        '/opt/homebrew/bin/npm',
        '/usr/local/bin/npm',
        for (final directory in (Platform.environment['PATH'] ?? '').split(':'))
          if (directory.isNotEmpty) '$directory/npm',
      ].firstWhere((path) => File(path).existsSync(), orElse: () => '');

  Future<String> _prepareBundledCloudCli() async {
    final runtime = Directory(_managedCloudCliPath);
    await runtime.parent.create(recursive: true);
    final copy = await Process.run('/usr/bin/ditto', [
      _bundledCloudCliPath,
      runtime.path,
    ]);
    if (copy.exitCode != 0) {
      throw StateError('无法复制内置 CloudCLI：${copy.stderr}');
    }

    final lock = File('${runtime.path}/package-lock.json');
    final installedLock =
        File('${runtime.path}/.agentremote-installed-lock.json');
    if (!Directory('${runtime.path}/node_modules').existsSync() ||
        !installedLock.existsSync() ||
        await installedLock.readAsString() != await lock.readAsString()) {
      if (_npmPath.isEmpty) {
        throw StateError('未找到 npm。请先安装 Node.js 22 或 24，再启动后台服务。');
      }
      if (mounted) setState(() => status = '正在安装 CloudCLI 运行依赖，首次启动需要联网…');
      final install = await Process.run(
        _npmPath,
        ['ci', '--omit=dev', '--no-audit', '--no-fund'],
        workingDirectory: runtime.path,
        environment: {
          'PATH':
              '${File(_nodePath).parent.path}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${Platform.environment['PATH'] ?? ''}',
        },
      );
      if (install.exitCode != 0) {
        throw StateError('CloudCLI 运行依赖安装失败：${install.stderr}');
      }
      await installedLock.writeAsString(await lock.readAsString());
    }
    return runtime.path;
  }

  @override
  void initState() {
    super.initState();
    unawaited(_initialize());
  }

  @override
  void dispose() {
    _pairTimer?.cancel();
    super.dispose();
  }

  Future<void> _closePairing() async {
    final token = _pairToken;
    final address = _pairAddress;
    _pairTimer?.cancel();
    if (mounted) {
      setState(() {
        _pairToken = null;
        _pairAddress = null;
      });
    }
    if (token == null || address == null) return;
    final client = _directHttpClient(const Duration(seconds: 3));
    try {
      final request = await client.deleteUrl(
        address.resolve('/api/desktop-pairing/$token'),
      );
      await (await request.close()).drain<void>();
    } catch (_) {
      // The server also expires unclaimed codes after five minutes.
    } finally {
      client.close();
    }
  }

  Future<void> _startPairing() async {
    final address = selectedAddress;
    if (!running || busy || pairingBusy || address == null) return;
    await _closePairing();
    if (!mounted) return;
    setState(() => pairingBusy = true);
    final origin = Uri.parse('http://$address:3001');
    final client = _directHttpClient(const Duration(seconds: 5));
    try {
      final request = await client.postUrl(
        origin.resolve('/api/desktop-pairing/start'),
      );
      final response = await request.close();
      if (response.statusCode == HttpStatus.notFound) {
        throw StateError('请先停止并重新启动后台服务，以启用一次性二维码');
      }
      if (response.statusCode != HttpStatus.ok) throw StateError('服务未接受配对请求');
      final body = jsonDecode(
        await utf8.decoder.bind(response).join(),
      ) as Map<String, dynamic>;
      final token = body['token'] as String;
      if (!mounted || !running || selectedAddress != address) return;
      setState(() {
        _pairToken = token;
        _pairAddress = origin;
      });
      _pairTimer = Timer.periodic(
        const Duration(seconds: 2),
        (_) => unawaited(_pollPairing()),
      );
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('无法生成二维码：$error')));
      }
    } finally {
      client.close();
      if (mounted) setState(() => pairingBusy = false);
    }
  }

  Future<void> _pollPairing() async {
    final token = _pairToken;
    final address = _pairAddress;
    if (_pollingPair || token == null || address == null) return;
    _pollingPair = true;
    final client = _directHttpClient(const Duration(seconds: 3));
    try {
      final request = await client.getUrl(
        address.resolve('/api/desktop-pairing/status/$token'),
      );
      final response = await request.close();
      final body = response.statusCode == HttpStatus.ok
          ? jsonDecode(await utf8.decoder.bind(response).join())
              as Map<String, dynamic>
          : null;
      if (!mounted || _pairToken != token) return;
      if (body?['status'] == 'claimed' ||
          response.statusCode == HttpStatus.notFound) {
        _pairTimer?.cancel();
        setState(() {
          _pairToken = null;
          _pairAddress = null;
        });
        if (body?['status'] == 'claimed') {
          ScaffoldMessenger.of(context)
              .showSnackBar(const SnackBar(content: Text('手机已成功连接，二维码已关闭')));
        }
      }
    } catch (_) {
      // A transient network failure should not invalidate a still-live code.
    } finally {
      client.close();
      _pollingPair = false;
    }
  }

  Future<void> _initialize() async {
    String? savedCloudCliPath;
    try {
      final config = jsonDecode(await File(_consoleConfigPath).readAsString());
      final path = (config as Map<String, dynamic>)['cloudCliPath'];
      if (path is String) savedCloudCliPath = _resolveCloudCliDirectory(path);
    } catch (_) {
      // First launch or an outdated saved path falls back to discovery.
    }
    final interfaces = await NetworkInterface.list(
      type: InternetAddressType.IPv4,
      includeLoopback: false,
      includeLinkLocal: false,
    );
    final ips = interfaces
        .expand((entry) => entry.addresses)
        .map((entry) => entry.address)
        .toSet()
        .toList()
      ..sort((a, b) => _addressRank(a).compareTo(_addressRank(b)));
    final serviceRunning = await _isLoaded();
    final existingServer = !serviceRunning && await _hasLiveCloudCliServer();
    if (!mounted) return;
    savedCloudCliPath ??= _findCloudCliPath();
    setState(() {
      _configuredCloudCliPath = savedCloudCliPath;
      addresses = ips;
      selectedAddress = ips.isEmpty ? null : ips.first;
      running = serviceRunning || existingServer;
      _launchAgentManaged = serviceRunning;
      status = serviceRunning
          ? 'CloudCLI 后台服务正在运行'
          : existingServer
              ? '检测到 CloudCLI 已由其他方式启动'
              : 'CloudCLI 后台服务未启动';
    });
  }

  int _addressRank(String address) {
    if (address.startsWith('192.168.')) return 0;
    if (address.startsWith('10.') || address.startsWith('172.')) return 1;
    if (address.startsWith('100.')) return 2;
    return 3;
  }

  Future<String> _userDomain() async {
    final result = await Process.run('/usr/bin/id', ['-u']);
    if (result.exitCode != 0) throw StateError('${result.stderr}');
    return 'gui/${(result.stdout as String).trim()}';
  }

  Future<bool> _isLoaded() async {
    try {
      final domain = await _userDomain();
      final result = await Process.run('/bin/launchctl', [
        'print',
        '$domain/$_serviceLabel',
      ]);
      return result.exitCode == 0;
    } catch (_) {
      return false;
    }
  }

  String? get _lanAddress =>
      addresses.where((ip) => !ip.startsWith('100.')).firstOrNull;

  Future<bool> _usesTailscaleHttpPort() async {
    if (!File(_tailscalePath).existsSync()) return false;
    try {
      final result = await Process.run(_tailscalePath, [
        'serve',
        'status',
        '--json',
      ]);
      if (result.exitCode != 0) return false;
      final status =
          jsonDecode(result.stdout as String) as Map<String, dynamic>;
      final tcp = status['TCP'];
      return tcp is Map && tcp.containsKey('3001');
    } catch (_) {
      return false;
    }
  }

  Future<void> _pointTailscaleServeToLan(String lanAddress) async {
    if (!await _usesTailscaleHttpPort()) return;
    final result = await Process.run(_tailscalePath, [
      'serve',
      '--bg',
      '--http=3001',
      'http://$lanAddress:3001',
    ]);
    if (result.exitCode != 0) {
      throw StateError('无法更新 Tailscale Serve 的 3001 端口：${result.stderr}');
    }
  }

  String _xml(String value) => value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');

  Future<void> _start() async {
    if (busy || running) return;
    setState(() {
      busy = true;
      status = '正在启动 CloudCLI 后台服务…';
    });
    try {
      final domain = await _userDomain();
      if (await _isLoaded()) {
        if (mounted) {
          setState(() {
            running = true;
            _launchAgentManaged = true;
            status = 'CloudCLI 后台服务正在运行；关闭此窗口后仍会继续运行';
          });
        }
        return;
      }
      if (await _hasLiveCloudCliServer()) {
        if (mounted) {
          setState(() {
            running = true;
            _launchAgentManaged = false;
            status = 'CloudCLI 已经在运行，已复用现有服务';
          });
        }
        return;
      }
      if (_cloudCliPath.isEmpty) {
        throw StateError(
          '未找到 CloudCLI。请重新安装控制台应用，或选择本地 CloudCLI 项目目录。',
        );
      }
      if (!File(_nodePath).existsSync()) {
        throw StateError('未找到 Node.js。请先安装 Node.js 22 或 24，再启动后台服务。');
      }
      final servicePath = _cloudCliPath == _bundledCloudCliPath
          ? await _prepareBundledCloudCli()
          : _cloudCliPath;
      final cli = File(_cloudCliEntry(servicePath));
      if (!cli.existsSync()) {
        if (!File('$servicePath/server/modules/cli/cli.service.ts')
            .existsSync()) {
          throw StateError(
            '找到的 CloudCLI 安装缺少服务器文件。请重新安装 CloudCLI，或选择 CloudCLI 项目目录。',
          );
        }
        if (!Directory('$servicePath/node_modules').existsSync()) {
          throw StateError(
            'CloudCLI 依赖尚未安装。请在“CloudCLI 项目目录”运行：\n'
            'cd "$servicePath" && npm ci && npm run build',
          );
        }
        final npmPath = _npmPath;
        if (npmPath.isEmpty) {
          throw StateError(
            '检测到 CloudCLI 源码，但找不到 npm。请先安装 Node.js 22 或 24，再运行：\n'
            'cd "$servicePath" && npm ci && npm run build',
          );
        }
        if (mounted) {
          setState(() => status = '正在首次构建 CloudCLI…');
        }
        final build = await Process.run(
          npmPath,
          ['run', 'build'],
          workingDirectory: servicePath,
          environment: {
            'PATH':
                '${File(_nodePath).parent.path}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${Platform.environment['PATH'] ?? ''}',
          },
        );
        if (build.exitCode != 0 || !cli.existsSync()) {
          final details = '${build.stderr}\n${build.stdout}'.trim();
          throw StateError(
            'CloudCLI 构建失败。请在“CloudCLI 项目目录”运行：\n'
            'cd "$servicePath" && npm ci && npm run build'
            '${details.isEmpty ? '' : '\n\n$details'}',
          );
        }
      }
      final launchAgents = Directory('$_home/Library/LaunchAgents');
      final logs = Directory('$_home/Library/Logs/AgentRemote');
      await launchAgents.create(recursive: true);
      await logs.create(recursive: true);
      final lanAddress = _lanAddress;
      final usesTailscaleServe = await _usesTailscaleHttpPort();
      if (usesTailscaleServe && lanAddress != null) {
        await _pointTailscaleServeToLan(lanAddress);
      }
      final path =
          '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${Platform.environment['PATH'] ?? ''}';
      final plist = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$_serviceLabel</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>${_xml(_nodePath)}</string><string>${_xml(cli.path)}</string>
    <string>--port=3001</string>
  </array>
  <key>WorkingDirectory</key><string>${_xml(servicePath)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOST</key><string>${usesTailscaleServe ? lanAddress ?? '127.0.0.1' : '0.0.0.0'}</string>
    <key>PATH</key><string>${_xml(path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${_xml('${logs.path}/cloudcli.log')}</string>
  <key>StandardErrorPath</key><string>${_xml('${logs.path}/cloudcli-error.log')}</string>
</dict></plist>
''';
      await File(_plistPath).writeAsString(plist);
      final result = await Process.run('/bin/launchctl', [
        'bootstrap',
        domain,
        _plistPath,
      ]);
      if (result.exitCode != 0 && !await _isLoaded()) {
        throw StateError('${result.stderr}');
      }
      final client = _directHttpClient(const Duration(seconds: 2));
      try {
        final probeHost =
            usesTailscaleServe ? lanAddress ?? '127.0.0.1' : '127.0.0.1';
        var ready = false;
        for (var attempt = 0; attempt < 30; attempt++) {
          await Future<void>.delayed(const Duration(milliseconds: 500));
          try {
            final request = await client.getUrl(
              Uri.parse('http://$probeHost:3001/health'),
            );
            final response = await request.close();
            final body = response.statusCode == HttpStatus.ok
                ? jsonDecode(await utf8.decoder.bind(response).join())
                    as Map<String, dynamic>
                : null;
            if (body?['status'] == 'ok') {
              ready = true;
              break;
            }
          } catch (_) {}
        }
        if (!ready) {
          throw StateError(
            '服务未能在 15 秒内启动。请查看 ~/Library/Logs/AgentRemote/cloudcli-error.log',
          );
        }
      } finally {
        client.close();
      }
      if (mounted) {
        setState(() {
          running = true;
          _launchAgentManaged = true;
          status = 'CloudCLI 后台服务正在运行；关闭此窗口后仍会继续运行';
        });
      }
    } catch (error) {
      if (mounted) setState(() => status = '启动失败：$error');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> _stop() async {
    if (busy || !running) return;
    if (!_launchAgentManaged) {
      setState(() => status = 'CloudCLI 是由其他方式启动的，请在原终端或服务管理器中停止。');
      return;
    }
    await _closePairing();
    setState(() => busy = true);
    try {
      final domain = await _userDomain();
      final result = await Process.run('/bin/launchctl', [
        'bootout',
        '$domain/$_serviceLabel',
      ]);
      if (result.exitCode != 0) throw StateError('${result.stderr}');
      final plist = File(_plistPath);
      if (await plist.exists()) await plist.delete();
      if (mounted) {
        setState(() {
          running = false;
          _launchAgentManaged = false;
          status = 'CloudCLI 后台服务已停止';
        });
      }
    } catch (error) {
      if (mounted) setState(() => status = '停止失败：$error');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final url = selectedAddress == null ? null : 'http://$selectedAddress:3001';
    return Scaffold(
      appBar: AppBar(title: const Text('Agent 遥控台电脑服务')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              const Text('选择手机可以访问的地址', style: TextStyle(fontSize: 20)),
              const SizedBox(height: 12),
              DropdownButtonFormField<String>(
                initialValue: selectedAddress,
                items: [
                  for (final ip in addresses)
                    DropdownMenuItem(value: ip, child: Text(ip)),
                ],
                onChanged: (value) {
                  unawaited(_closePairing());
                  setState(() => selectedAddress = value);
                },
                decoration: const InputDecoration(
                  labelText: '局域网或 Tailscale IPv4 地址',
                ),
              ),
              const SizedBox(height: 16),
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.folder_outlined),
                title: const Text('CloudCLI 项目目录'),
                subtitle: Text(
                  _cloudCliPath.isEmpty ? '尚未选择' : _cloudCliPath,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                trailing: TextButton(
                  onPressed: busy ? null : _chooseCloudCliDirectory,
                  child: const Text('选择'),
                ),
              ),
              if (_isCloudCliDirectory(Directory(_bundledCloudCliPath)) &&
                  _cloudCliPath != _bundledCloudCliPath)
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton(
                    onPressed: busy
                        ? null
                        : () => unawaited(
                              _saveCloudCliPath(_bundledCloudCliPath),
                            ),
                    child: const Text('改用应用内置 CloudCLI'),
                  ),
                ),
              const SizedBox(height: 8),
              SelectableText(status),
              const SizedBox(height: 16),
              FilledButton.icon(
                onPressed: busy || running ? null : _start,
                icon: const Icon(Icons.play_arrow),
                label: const Text('启动后台服务'),
              ),
              if (running && _launchAgentManaged) ...[
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: busy ? null : _stop,
                  icon: const Icon(Icons.stop),
                  label: const Text('停止并取消开机启动'),
                ),
              ] else if (running) ...[
                const SizedBox(height: 8),
                const Text('CloudCLI 由终端或其他服务管理器启动，请在那里停止。'),
              ],
              const SizedBox(height: 16),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '远程使用权限',
                        style: TextStyle(fontWeight: FontWeight.bold),
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        '离开 Mac 前检查文件和网络权限，完成后用手机连接一次。'
                        'macOS 的授权弹窗必须在电脑上确认。',
                      ),
                      const SizedBox(height: 8),
                      FilledButton.icon(
                        onPressed: permissionBusy || selectedAddress == null
                            ? null
                            : _prepareRemoteAccess,
                        icon: const Icon(Icons.verified_user_outlined),
                        label: Text(permissionBusy ? '正在检查…' : '检查并准备远程权限'),
                      ),
                    ],
                  ),
                ),
              ),
              if (running && url != null) ...[
                const SizedBox(height: 24),
                OutlinedButton.icon(
                  onPressed: pairingBusy
                      ? null
                      : _pairToken == null
                          ? _startPairing
                          : _closePairing,
                  icon: Icon(_pairToken == null ? Icons.qr_code : Icons.close),
                  label: Text(_pairToken == null ? '显示一次性二维码' : '关闭二维码'),
                ),
                if (_pairToken != null) ...[
                  const SizedBox(height: 16),
                  Center(
                    child: QrImageView(
                      data: '$url?pair=$_pairToken',
                      size: 300,
                      backgroundColor: Colors.white,
                    ),
                  ),
                  const SizedBox(height: 8),
                  const Text(
                    '手机成功打开服务后，二维码会自动关闭；5 分钟后自动失效。',
                    textAlign: TextAlign.center,
                  ),
                ],
                const SizedBox(height: 12),
                SelectableText(url, textAlign: TextAlign.center),
                const SizedBox(height: 12),
                const Text(
                  '安卓基座扫码后可切换已保存的本地和 Tailscale 地址。服务随登录启动，允许 Mac 熄屏；合盖休眠仍会断开。',
                  textAlign: TextAlign.center,
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
