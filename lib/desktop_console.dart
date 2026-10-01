import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:qr_flutter/qr_flutter.dart';

import 'file_relay.dart';

const _serviceLabel = 'dev.agentremote.cloudcli';
const _openCodeServiceLabel = 'dev.agentremote.opencode';
const _watchdogServiceLabel = 'dev.agentremote.watchdog';

/// Seconds between watchdog health checks, also written into the LaunchAgent
/// and shown in the console so the two never drift apart.
const _watchdogIntervalSeconds = 60;

class DesktopConsoleApp extends StatelessWidget {
  const DesktopConsoleApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'Agent 控制台',
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
  bool openCodeRunning = false;
  bool openCodeBusy = false;
  bool _openCodeManaged = false;
  int? openCodePort;
  String openCodeStatus = 'OpenCode SDK 服务未启动';
  RelayProvider relayProvider = RelayProvider.tmpfiles;
  String relayPath = '';
  bool relayBusy = false;
  double relayProgress = 0;
  String relayStatus = '选择文件后上传，生成手机可打开的临时链接。';
  RelayUploadResult? relayResult;
  bool busy = false;
  bool pairingBusy = false;
  // Prevents duplicate checks while macOS is handling a local-network prompt.
  bool permissionBusy = false;
  String? _pairToken;
  Uri? _pairAddress;
  Timer? _pairTimer;
  bool _pollingPair = false;
  bool watchdogEnabled = false;
  bool watchdogBusy = false;
  String watchdogStatus = '守护进程未开启';

  String get _home => Platform.environment['HOME'] ?? '';
  String get _plistPath => '$_home/Library/LaunchAgents/$_serviceLabel.plist';
  String get _openCodePlistPath =>
      '$_home/Library/LaunchAgents/$_openCodeServiceLabel.plist';
  String get _watchdogPlistPath =>
      '$_home/Library/LaunchAgents/$_watchdogServiceLabel.plist';
  String get _watchdogScriptPath =>
      '$_home/Library/Application Support/AgentRemote/service-watchdog.sh';
  String get _consoleConfigPath =>
      '$_home/Library/Application Support/AgentRemote/desktop-console.json';
  // Shared with CloudCLI: the server reads this descriptor and attaches to the
  // advertised OpenCode server instead of spawning a throwaway one per turn.
  String get _openCodeDescriptorPath =>
      '$_home/.agent-remote/opencode-server.json';
  String get _tailscalePath => '/usr/local/bin/tailscale';
  String get _cloudCliPath => _configuredCloudCliPath ?? '';
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

  late final String _openCodePath = [
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    '$_home/.opencode/bin/opencode',
    '$_home/.bun/bin/opencode',
    for (final directory in (Platform.environment['PATH'] ?? '').split(':'))
      if (directory.isNotEmpty) '$directory/opencode',
  ].firstWhere((path) => File(path).existsSync(), orElse: () => '');

  String get _consoleAppPath {
    var directory = File(Platform.resolvedExecutable).parent;
    while (directory.parent.path != directory.path) {
      if (directory.path.endsWith('.app')) return directory.path;
      directory = directory.parent;
    }
    return Platform.resolvedExecutable;
  }

  /// Programs macOS may require in Full Disk Access before the background agent
  /// server can read project files. Resolved on demand so "重新检测" picks up an
  /// agent installed while this window stayed open.
  List<_DiskAccessTarget> _diskAccessTargets = const [];

  List<_DiskAccessTarget> _resolveDiskAccessTargets() {
    String? firstExisting(Iterable<String> candidates) {
      for (final candidate in candidates) {
        if (candidate.isEmpty) continue;
        try {
          if (File(candidate).existsSync() ||
              Directory(candidate).existsSync()) {
            return candidate;
          }
        } catch (_) {
          // A path we cannot stat is simply not a match.
        }
      }
      return null;
    }

    List<String> onPath(String command) => [
          for (final directory in (Platform.environment['PATH'] ?? '').split(':'))
            if (directory.isNotEmpty) '$directory/$command',
        ];

    final targets = <_DiskAccessTarget>[
      _DiskAccessTarget(label: '控制台', path: _consoleAppPath, isConsole: true),
      _DiskAccessTarget(label: '后台 Node', path: _nodePermissionPath),
    ];

    // Each coding agent runs as its own process, so macOS grants Full Disk
    // Access per executable rather than per provider.
    final agents = <String, List<String>>{
      'Claude': [
        '$_home/.claude/local/claude',
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        '$_home/.local/bin/claude',
        ...onPath('claude'),
      ],
      'Codex': [
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        '$_home/.local/bin/codex',
        ...onPath('codex'),
      ],
      'OpenCode': [
        _openCodePath,
        ...onPath('opencode'),
      ],
      'Cursor': [
        '/opt/homebrew/bin/cursor-agent',
        '/usr/local/bin/cursor-agent',
        '$_home/.local/bin/cursor-agent',
        '$_home/.cursor/bin/cursor-agent',
        ...onPath('cursor-agent'),
      ],
    };

    agents.forEach((label, candidates) {
      targets.add(
        _DiskAccessTarget(label: label, path: firstExisting(candidates) ?? ''),
      );
    });

    return targets;
  }

  /// Best-effort check for this console's own Full Disk Access grant: macOS
  /// only lets an authorized process open the TCC database. There is no public
  /// API to read another program's grant, so agent rows report install status
  /// instead and defer to System Settings.
  bool get _consoleHasFullDiskAccess {
    try {
      File('$_home/Library/Application Support/com.apple.TCC/TCC.db')
          .openSync()
          .closeSync();
      return true;
    } catch (_) {
      return false;
    }
  }

  Widget _buildDiskAccessCard() {
    return _card(
      title: '完全磁盘访问',
      icon: Icons.lock_open_outlined,
      children: [
        const Text(
          '后台服务需要读取项目文件。请为下面每个已安装的程序在“系统设置 → '
          '隐私与安全性 → 完全磁盘访问”中点“+”添加；在文件选择窗口按 '
          'Command-Shift-G 可粘贴路径。macOS 不提供逐程序的授权状态，'
          '请以系统设置里的开关为准。',
        ),
        const SizedBox(height: 16),
        for (final target in _diskAccessTargets) _buildDiskAccessRow(target),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            OutlinedButton.icon(
              onPressed: () => unawaited(_openFileAccessSettings()),
              icon: const Icon(Icons.lock_open_outlined),
              label: const Text('打开完全磁盘访问设置'),
            ),
            TextButton.icon(
              onPressed: () => setState(
                () => _diskAccessTargets = _resolveDiskAccessTargets(),
              ),
              icon: const Icon(Icons.refresh),
              label: const Text('重新检测'),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildDiskAccessRow(_DiskAccessTarget target) {
    final installed = target.path.isNotEmpty &&
        (File(target.path).existsSync() || Directory(target.path).existsSync());
    final authorized = target.isConsole ? _consoleHasFullDiskAccess : installed;
    final status = target.isConsole
        ? (authorized ? '已授权' : '未确认')
        : (installed ? '已安装' : '未找到');
    final statusColor = authorized ? Colors.greenAccent : Colors.orangeAccent;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
      decoration: BoxDecoration(
        color: Colors.white10,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  target.label,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: statusColor.withAlpha(40),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  status,
                  style: TextStyle(fontSize: 12, color: statusColor),
                ),
              ),
            ],
          ),
          if (target.path.isNotEmpty) ...[
            const SizedBox(height: 2),
            SelectableText(
              target.path,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
          Wrap(
            spacing: 8,
            children: [
              if (target.path.isNotEmpty)
                TextButton.icon(
                  onPressed: () => unawaited(_revealInFinder(target.path)),
                  icon: const Icon(Icons.folder_open_outlined, size: 16),
                  label: const Text('定位'),
                ),
              TextButton.icon(
                onPressed: () => unawaited(_openFileAccessSettings()),
                icon: const Icon(Icons.settings_outlined, size: 16),
                label: const Text('授权'),
              ),
            ],
          ),
        ],
      ),
    );
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
                '文件：在完整磁盘访问中点“+”添加下面列出的每个程序；未使用的 Agent 可以跳过。若应用列表里找不到，请在文件选择窗口按 Command-Shift-G 并粘贴显示的路径。',
              ),
              const SizedBox(height: 8),
              for (final target in _diskAccessTargets) ...[
                Text(
                  '${target.label}：\n'
                  '${target.path.isEmpty ? '未找到' : target.path}',
                ),
                if (target.path.isNotEmpty)
                  TextButton.icon(
                    onPressed: () => unawaited(_revealInFinder(target.path)),
                    icon: const Icon(Icons.folder_open_outlined),
                    label: Text('在 Finder 中定位${target.label}'),
                  ),
              ],
              const SizedBox(height: 12),
              const Text(
                '本地网络列表只会显示已经发起局域网请求的应用。点“检查并准备远程权限”触发请求并允许弹窗；若探测成功但列表没有控制台，无需再添加。防火墙若拦截，请在系统设置 → 网络 → 防火墙中添加 Node（以及 OpenCode）。离开 Mac 前用手机连接一次，以触发可能的入站提示。',
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
      File('${directory.path}/server/modules/cli/cli.service.ts').existsSync();

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

  String _findCloudCliPath() {
    for (final start in [
      Platform.environment['AGENT_REMOTE_PROJECT_ROOT'],
      Directory.current.path,
      File(Platform.resolvedExecutable).parent.path,
    ]) {
      if (start == null || start.isEmpty) continue;
      var directory = Directory(start);
      while (true) {
        if (_isCloudCliDirectory(directory)) {
          return directory.path;
        }
        final candidate = Directory('${directory.path}/cloudcli');
        if (_isCloudCliDirectory(candidate)) {
          return candidate.path;
        }
        if (directory.parent.path == directory.path) break;
        directory = directory.parent;
      }
    }
    return '';
  }

  String get _npmPath => [
        '${File(_nodePath).parent.path}/npm',
        '/opt/homebrew/bin/npm',
        '/usr/local/bin/npm',
        for (final directory in (Platform.environment['PATH'] ?? '').split(':'))
          if (directory.isNotEmpty) '$directory/npm',
      ].firstWhere((path) => File(path).existsSync(), orElse: () => '');

  @override
  void initState() {
    super.initState();
    _diskAccessTargets = _resolveDiskAccessTargets();
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
    final openCodeLoaded = await _isOpenCodeLoaded();
    final watchdogLoaded = await _isWatchdogLoaded();
    final openCodeDescriptorPort = await _readOpenCodePort();
    final openCodeHealthy = openCodeDescriptorPort != null &&
        await _probeOpenCodeServer(openCodeDescriptorPort);
    if (!mounted) return;
    if (watchdogLoaded) {
      // Keep the on-disk script in step with this build; launchd reruns the
      // file each interval, so a plain rewrite is enough. Failures are benign.
      try {
        final script = File(_watchdogScriptPath);
        await script.parent.create(recursive: true);
        await script.writeAsString(_watchdogScript);
      } catch (_) {}
    }
    savedCloudCliPath ??= _findCloudCliPath();
    setState(() {
      _configuredCloudCliPath = savedCloudCliPath;
      addresses = ips;
      selectedAddress = ips.isEmpty ? null : ips.first;
      running = serviceRunning || existingServer;
      _launchAgentManaged = serviceRunning;
      openCodeRunning = openCodeHealthy;
      _openCodeManaged = openCodeLoaded;
      openCodePort = openCodeHealthy ? openCodeDescriptorPort : null;
      openCodeStatus = openCodeHealthy
          ? 'OpenCode CLI 服务正在运行，使用默认 OpenCode 账号'
          : 'OpenCode SDK 服务未启动';
      watchdogEnabled = watchdogLoaded;
      watchdogStatus = watchdogLoaded
          ? '守护进程正在运行：每 $_watchdogIntervalSeconds 秒检查一次 '
              'CloudCLI 与 OpenCode 服务，未运行会自动重新启动'
          : '守护进程未开启';
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

  /// Proxy entries the managed `opencode serve` LaunchAgent must inherit from
  /// this login session.
  ///
  /// A local rule-based proxy (Clash and friends) exports `http_proxy`,
  /// `https_proxy` and `all_proxy` for the whole GUI session. The LaunchAgent
  /// starts with a minimal environment, so without copying them here its
  /// `opencode-go` model calls to https://api.opencode.ai fail with
  /// "self signed certificate" while the desktop app - launched with the same
  /// session environment - keeps working. Loopback destinations stay exempt so
  /// health probes and CloudCLI keep using direct loopback connections.
  String _proxyEnvironmentEntries() {
    const names = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
    final values = <String, String>{};
    for (final name in names) {
      final value = Platform.environment[name] ?? Platform.environment[name.toUpperCase()];
      if (value == null || value.isEmpty) continue;
      values[name] = value;
      values[name.toUpperCase()] = value;
    }
    values.putIfAbsent('no_proxy', () => 'localhost,127.0.0.1,::1');
    values.putIfAbsent('NO_PROXY', () => 'localhost,127.0.0.1,::1');
    return values.entries
        .map((entry) => '    <key>${_xml(entry.key)}</key><string>${_xml(entry.value)}</string>')
        .join('\n');
  }

  Future<bool> _isOpenCodeLoaded() async {
    try {
      final domain = await _userDomain();
      final result = await Process.run('/bin/launchctl', [
        'print',
        '$domain/$_openCodeServiceLabel',
      ]);
      return result.exitCode == 0;
    } catch (_) {
      return false;
    }
  }

  Future<bool> _isWatchdogLoaded() async {
    try {
      final domain = await _userDomain();
      final result = await Process.run('/bin/launchctl', [
        'print',
        '$domain/$_watchdogServiceLabel',
      ]);
      return result.exitCode == 0;
    } catch (_) {
      return false;
    }
  }

  /// Shell script the watchdog LaunchAgent runs on every interval. It probes
  /// both managed services and restarts the ones whose LaunchAgent is loaded
  /// but no longer answers, so a crashed or hung server recovers on its own.
  String get _watchdogScript => r'''#!/bin/sh
# 由 Agent 控制台生成，请通过控制台的守护进程开关管理；手动修改会被覆盖。
PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
DOMAIN="gui/$(id -u)"
CLOUDCLI_LABEL="dev.agentremote.cloudcli"
OPENCODE_LABEL="dev.agentremote.opencode"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/AgentRemote"
LOG_FILE="$LOG_DIR/watchdog.log"

mkdir -p "$LOG_DIR" 2>/dev/null
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG_FILE" 2>/dev/null; }

healthy() {
  /usr/bin/curl -fsS --noproxy '*' --max-time 5 "$1" -o /dev/null 2>/dev/null
}

restart() {
  label="$1"
  plist="$LAUNCH_AGENTS/$label.plist"
  if /bin/launchctl kickstart -k "$DOMAIN/$label" >/dev/null 2>&1; then
    log "已重新启动 $label"
  elif [ -f "$plist" ] && /bin/launchctl bootstrap "$DOMAIN" "$plist" >/dev/null 2>&1; then
    log "已重新加载并启动 $label"
  else
    log "无法重新启动 $label"
  fi
}

# CloudCLI 后台服务：优先使用服务自己写入的可连接地址，兼容 Tailscale Serve。
if [ -f "$LAUNCH_AGENTS/$CLOUDCLI_LABEL.plist" ]; then
  url="http://127.0.0.1:3001"
  marker="$HOME/.cloudcli/local-server.json"
  if [ -f "$marker" ]; then
    parsed=$(/usr/bin/sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$marker" | /usr/bin/head -n 1)
    [ -n "$parsed" ] && url="$parsed"
  fi
  if ! healthy "$url/health"; then
    log "CloudCLI 健康检查失败（$url/health），尝试重新启动"
    restart "$CLOUDCLI_LABEL"
  fi
fi

# OpenCode SDK 服务：端口由控制台写入的共享描述文件提供。
if [ -f "$LAUNCH_AGENTS/$OPENCODE_LABEL.plist" ]; then
  port=""
  descriptor="$HOME/.agent-remote/opencode-server.json"
  if [ -f "$descriptor" ]; then
    port=$(/usr/bin/sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$descriptor" | /usr/bin/head -n 1)
  fi
  if [ -z "$port" ] || ! healthy "http://127.0.0.1:$port/config"; then
    log "OpenCode 健康检查失败（端口 ${port:-未知}），尝试重新启动"
    restart "$OPENCODE_LABEL"
  fi
fi
''';

  Future<int?> _readOpenCodePort() async {
    try {
      final descriptor =
          jsonDecode(await File(_openCodeDescriptorPath).readAsString())
              as Map<String, dynamic>;
      final port = descriptor['port'];
      return port is int && port > 0 ? port : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> _writeOpenCodeDescriptor(int port) async {
    final file = File(_openCodeDescriptorPath);
    await file.parent.create(recursive: true);
    await file.writeAsString(jsonEncode({
      'url': 'http://127.0.0.1:$port',
      'host': '0.0.0.0',
      'port': port,
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    }));
  }

  Future<void> _deleteOpenCodeDescriptor() async {
    final file = File(_openCodeDescriptorPath);
    if (await file.exists()) await file.delete();
  }

  Future<bool> _probeOpenCodeServer(int port) async {
    final client = _directHttpClient(const Duration(seconds: 2));
    try {
      final request = await client.getUrl(
        Uri.parse('http://127.0.0.1:$port/config'),
      );
      final response = await request.close();
      await response.drain<void>();
      return response.statusCode == HttpStatus.ok;
    } catch (_) {
      return false;
    } finally {
      client.close();
    }
  }

  /// Reserves a free loopback port and releases it again so the OpenCode
  /// LaunchAgent can bind it on any interface without a hardcoded port.
  Future<int> _findFreePort() async {
    final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final port = socket.port;
    await socket.close();
    return port;
  }

  Future<void> _startOpenCode() async {
    if (openCodeBusy || openCodeRunning) return;
    setState(() {
      openCodeBusy = true;
      openCodeStatus = '正在启动 OpenCode SDK 服务…';
    });
    try {
      final openCodePath = _openCodePath;
      if (openCodePath.isEmpty) {
        throw StateError(
          '未找到 opencode 命令。请先安装 OpenCode CLI（https://opencode.ai/docs/）。',
        );
      }
      final domain = await _userDomain();
      // A loaded agent may be crash-looping on a port that something else took
      // over since it started; drop it so this start can pick a fresh free port.
      if (await _isOpenCodeLoaded()) {
        await Process.run('/bin/launchctl', [
          'bootout',
          '$domain/$_openCodeServiceLabel',
        ]);
      }
      final port = await _findFreePort();
      final launchAgents = Directory('$_home/Library/LaunchAgents');
      final logs = Directory('$_home/Library/Logs/AgentRemote');
      await launchAgents.create(recursive: true);
      await logs.create(recursive: true);
      final path =
          '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${Platform.environment['PATH'] ?? ''}';
      final proxyEntries = _proxyEnvironmentEntries();
      final plist = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$_openCodeServiceLabel</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>${_xml(openCodePath)}</string><string>serve</string>
    <string>--hostname</string><string>0.0.0.0</string>
    <string>--port</string><string>$port</string>
  </array>
  <key>WorkingDirectory</key><string>${_xml(_home)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${_xml(path)}</string>
$proxyEntries
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${_xml('${logs.path}/opencode.log')}</string>
  <key>StandardErrorPath</key><string>${_xml('${logs.path}/opencode-error.log')}</string>
</dict></plist>
''';
      await File(_openCodePlistPath).writeAsString(plist);
      var bootstrapSucceeded = false;
      var bootstrapError = '';
      for (var attempt = 0; attempt < 5; attempt++) {
        final result = await Process.run('/bin/launchctl', [
          'bootstrap',
          domain,
          _openCodePlistPath,
        ]);
        bootstrapSucceeded = result.exitCode == 0 || await _isOpenCodeLoaded();
        if (bootstrapSucceeded) break;
        bootstrapError = '${result.stderr}';
        // launchd can briefly refuse a label right after bootout releases it.
        await Future<void>.delayed(const Duration(milliseconds: 400));
      }
      if (!bootstrapSucceeded) {
        throw StateError(bootstrapError);
      }
      var ready = false;
      for (var attempt = 0; attempt < 40; attempt++) {
        await Future<void>.delayed(const Duration(milliseconds: 500));
        if (await _probeOpenCodeServer(port)) {
          ready = true;
          break;
        }
      }
      if (!ready) {
        throw StateError(
          '服务未能在 20 秒内启动。请查看 ~/Library/Logs/AgentRemote/opencode-error.log',
        );
      }
      await _writeOpenCodeDescriptor(port);
      if (mounted) {
        setState(() {
          openCodeRunning = true;
          _openCodeManaged = true;
          openCodePort = port;
          openCodeStatus = 'OpenCode CLI 服务正在运行，使用默认 OpenCode 账号';
        });
      }
    } catch (error) {
      if (mounted) setState(() => openCodeStatus = '启动失败：$error');
    } finally {
      if (mounted) setState(() => openCodeBusy = false);
    }
  }

  Future<void> _stopOpenCode() async {
    if (openCodeBusy || !openCodeRunning) return;
    if (!_openCodeManaged) {
      setState(() => openCodeStatus = 'OpenCode 由其他方式启动，请在原终端或服务管理器中停止。');
      return;
    }
    setState(() => openCodeBusy = true);
    try {
      final domain = await _userDomain();
      final result = await Process.run('/bin/launchctl', [
        'bootout',
        '$domain/$_openCodeServiceLabel',
      ]);
      if (result.exitCode != 0) throw StateError('${result.stderr}');
      final plist = File(_openCodePlistPath);
      if (await plist.exists()) await plist.delete();
      // Removing the descriptor stops CloudCLI from attaching to a dead server.
      await _deleteOpenCodeDescriptor();
      if (mounted) {
        setState(() {
          openCodeRunning = false;
          _openCodeManaged = false;
          openCodePort = null;
          openCodeStatus = 'OpenCode SDK 服务已停止';
        });
      }
    } catch (error) {
      if (mounted) setState(() => openCodeStatus = '停止失败：$error');
    } finally {
      if (mounted) setState(() => openCodeBusy = false);
    }
  }

  Future<void> _startWatchdog() async {
    if (watchdogBusy || watchdogEnabled) return;
    setState(() {
      watchdogBusy = true;
      watchdogStatus = '正在开启守护进程…';
    });
    try {
      final launchAgents = Directory('$_home/Library/LaunchAgents');
      final logs = Directory('$_home/Library/Logs/AgentRemote');
      await launchAgents.create(recursive: true);
      await logs.create(recursive: true);
      final script = File(_watchdogScriptPath);
      await script.parent.create(recursive: true);
      await script.writeAsString(_watchdogScript);
      final plist = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$_watchdogServiceLabel</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string>
    <string>${_xml(script.path)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>$_watchdogIntervalSeconds</integer>
  <key>StandardOutPath</key><string>${_xml('${logs.path}/watchdog-out.log')}</string>
  <key>StandardErrorPath</key><string>${_xml('${logs.path}/watchdog-error.log')}</string>
</dict></plist>
''';
      await File(_watchdogPlistPath).writeAsString(plist);
      final domain = await _userDomain();
      var bootstrapSucceeded = false;
      var bootstrapError = '';
      for (var attempt = 0; attempt < 5; attempt++) {
        final result = await Process.run('/bin/launchctl', [
          'bootstrap',
          domain,
          _watchdogPlistPath,
        ]);
        bootstrapSucceeded = result.exitCode == 0 || await _isWatchdogLoaded();
        if (bootstrapSucceeded) break;
        bootstrapError = '${result.stderr}';
        // launchd can briefly refuse a label right after bootout releases it.
        await Future<void>.delayed(const Duration(milliseconds: 400));
      }
      if (!bootstrapSucceeded) throw StateError(bootstrapError);
      if (mounted) {
        setState(() {
          watchdogEnabled = true;
          watchdogStatus = '守护进程正在运行：每 $_watchdogIntervalSeconds 秒检查一次 '
              'CloudCLI 与 OpenCode 服务，未运行会自动重新启动';
        });
      }
    } catch (error) {
      if (mounted) setState(() => watchdogStatus = '开启失败：$error');
    } finally {
      if (mounted) setState(() => watchdogBusy = false);
    }
  }

  Future<void> _stopWatchdog() async {
    if (watchdogBusy || !watchdogEnabled) return;
    setState(() => watchdogBusy = true);
    try {
      final domain = await _userDomain();
      final result = await Process.run('/bin/launchctl', [
        'bootout',
        '$domain/$_watchdogServiceLabel',
      ]);
      if (result.exitCode != 0) throw StateError('${result.stderr}');
      final plist = File(_watchdogPlistPath);
      if (await plist.exists()) await plist.delete();
      if (mounted) {
        setState(() {
          watchdogEnabled = false;
          watchdogStatus = '守护进程已关闭';
        });
      }
    } catch (error) {
      if (mounted) setState(() => watchdogStatus = '关闭失败：$error');
    } finally {
      if (mounted) setState(() => watchdogBusy = false);
    }
  }

  Future<void> _chooseRelayFile() async {
    if (relayBusy) return;
    try {
      final selected = await _consoleChannel.invokeMethod<String>(
        'chooseRelayFile',
        {'initialPath': _home},
      );
      if (selected != null && selected.isNotEmpty && mounted) {
        setState(() {
          relayPath = selected;
          relayResult = null;
          relayStatus = '已选择文件，点击“上传并生成链接”。';
        });
      }
    } catch (error) {
      if (mounted) setState(() => relayStatus = '无法选择文件：$error');
    }
  }

  Future<void> _uploadRelay() async {
    if (relayBusy || relayPath.isEmpty) return;
    final file = File(relayPath);
    if (!await file.exists()) {
      if (mounted) setState(() => relayStatus = '文件不存在：$relayPath');
      return;
    }
    setState(() {
      relayBusy = true;
      relayProgress = 0;
      relayResult = null;
      relayStatus = '正在上传到 ${relayProvider.label}…';
    });
    try {
      final result = await FileRelay.upload(
        file,
        relayProvider,
        onProgress: (progress) {
          if (mounted) setState(() => relayProgress = progress);
        },
      );
      if (mounted) {
        setState(() {
          relayResult = result;
          relayStatus = '上传完成。链接有效期由服务商决定，过期后请重新上传。';
        });
      }
    } catch (error) {
      if (mounted) setState(() => relayStatus = '$error');
    } finally {
      if (mounted) setState(() => relayBusy = false);
    }
  }

  Future<void> _copyRelayLink() async {
    final url = relayResult?.url;
    if (url == null) return;
    await Clipboard.setData(ClipboardData(text: url));
    if (mounted) setState(() => relayStatus = '链接已复制。');
  }

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
        throw StateError('未找到 CloudCLI 源码目录，请选择本地 CloudCLI 项目目录。');
      }
      if (!File(_nodePath).existsSync()) {
        throw StateError('未找到 Node.js。请先安装 Node.js 22 或 24，再启动后台服务。');
      }
      final servicePath = _cloudCliPath;
      if (!_isCloudCliDirectory(Directory(servicePath))) {
        throw StateError('所选目录不是 CloudCLI 源码目录，请重新选择 CloudCLI 项目目录。');
      }
      final npmPath = _npmPath;
      if (npmPath.isEmpty) {
        throw StateError('未找到 npm。请先安装 Node.js 22 或 24，再启动后台服务。');
      }
      final lockFile = File('$servicePath/package-lock.json');
      if (!lockFile.existsSync()) {
        throw StateError('所选 CloudCLI 目录缺少 package-lock.json，无法自动安装依赖。');
      }
      final nodeModules = Directory('$servicePath/node_modules');
      final hasInstalledDependencies = nodeModules.existsSync() &&
          File('${nodeModules.path}/.package-lock.json').existsSync() &&
          ['vite', 'tsc', 'tsc-alias'].every(
            (tool) => File('${nodeModules.path}/.bin/$tool').existsSync(),
          );
      if (!hasInstalledDependencies) {
        if (mounted) setState(() => status = '正在安装 CloudCLI 依赖…');
        final install = await Process.run(
          npmPath,
          ['ci', '--no-audit', '--no-fund'],
          workingDirectory: servicePath,
          environment: {
            'PATH':
                '${File(_nodePath).parent.path}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${Platform.environment['PATH'] ?? ''}',
          },
        );
        if (install.exitCode != 0) {
          final details = '${install.stderr}\n${install.stdout}'.trim();
          throw StateError(
            'CloudCLI 依赖安装失败。请检查网络和 package-lock.json。'
            '${details.isEmpty ? '' : '\n\n$details'}',
          );
        }
      }
      if (mounted) setState(() => status = '正在构建 CloudCLI…');
      final build = await Process.run(
        npmPath,
        ['run', 'build'],
        workingDirectory: servicePath,
        environment: {
          'PATH':
              '${File(_nodePath).parent.path}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${Platform.environment['PATH'] ?? ''}',
        },
      );
      final cli = File(_cloudCliEntry(servicePath));
      if (build.exitCode != 0 || !cli.existsSync()) {
        final details = '${build.stderr}\n${build.stdout}'.trim();
        throw StateError(
          'CloudCLI 构建失败。'
          '${details.isEmpty ? '' : '\n\n$details'}',
        );
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
    return DefaultTabController(
      length: 4,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Agent 控制台'),
          bottom: const TabBar(
            tabs: [
              Tab(icon: Icon(Icons.dns_outlined), text: '服务'),
              Tab(icon: Icon(Icons.qr_code_2_outlined), text: '连接'),
              Tab(icon: Icon(Icons.folder_open_outlined), text: '文件'),
              Tab(icon: Icon(Icons.verified_user_outlined), text: '权限'),
            ],
          ),
        ),
        body: TabBarView(
          children: [
            _buildServicesTab(),
            _buildConnectionTab(),
            _buildFilesTab(),
            _buildPermissionsTab(),
          ],
        ),
      ),
    );
  }

  /// Shared scroll frame for one tab: centered with a comfortable reading
  /// width so the console still looks like a settings window when the desktop
  /// window is very wide.
  Widget _tabScroll(List<Widget> children) => Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 720),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: children,
          ),
        ),
      );

  /// Section card shared by every tab so the console reads as one UI.
  Widget _card({
    required String title,
    IconData? icon,
    required List<Widget> children,
  }) =>
      Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  if (icon != null) ...[
                    Icon(
                      icon,
                      size: 18,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                    const SizedBox(width: 8),
                  ],
                  Text(
                    title,
                    style: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              ...children,
            ],
          ),
        ),
      );

  Widget _buildServicesTab() {
    return _tabScroll([
      _card(
        title: 'CloudCLI 后台服务',
        icon: Icons.dns_outlined,
        children: [
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
          const Text(
            '缺少依赖时会自动运行 npm ci，然后运行 npm run build；更新依赖后请重新运行 npm ci。',
          ),
          const SizedBox(height: 12),
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
        ],
      ),
      const SizedBox(height: 16),
      _card(
        title: 'OpenCode SDK 服务',
        icon: Icons.extension_outlined,
        children: [
          const Text(
            '此服务使用默认 OpenCode 数据目录，供没有桌面客户端时使用。'
            '手机通信由上方的 CloudCLI 后台服务负责；'
            '不同账号请分别打开各自独立数据目录的 OpenCode 桌面客户端。',
          ),
          const SizedBox(height: 12),
          SelectableText(openCodeStatus),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: openCodeBusy || openCodeRunning ? null : _startOpenCode,
            icon: const Icon(Icons.play_arrow),
            label: Text(openCodeBusy ? '正在启动…' : '启动 OpenCode 服务'),
          ),
          if (openCodeRunning && _openCodeManaged) ...[
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: openCodeBusy ? null : _stopOpenCode,
              icon: const Icon(Icons.stop),
              label: const Text('停止 OpenCode 服务'),
            ),
          ] else if (openCodeRunning) ...[
            const SizedBox(height: 8),
            const Text('OpenCode 由其他方式启动，请在原终端或服务管理器中停止。'),
          ],
          if (openCodeRunning && openCodePort != null) ...[
            const SizedBox(height: 12),
            SelectableText('本机地址：http://127.0.0.1:$openCodePort'),
            if (selectedAddress != null)
              SelectableText('手机地址：http://$selectedAddress:$openCodePort'),
          ],
        ],
      ),
      const SizedBox(height: 16),
      _card(
        title: '服务守护进程',
        icon: Icons.monitor_heart_outlined,
        children: [
          const Text(
            '开启后由常驻后台守护进程定时检查 CloudCLI 与 OpenCode 服务；'
            '一旦发现没在运行就自动重新启动。登录后也会继续生效，'
            '因此需要先启动过对应服务。',
          ),
          const SizedBox(height: 12),
          SelectableText(watchdogStatus),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: watchdogBusy || watchdogEnabled ? null : _startWatchdog,
            icon: const Icon(Icons.play_arrow),
            label: Text(watchdogBusy ? '正在开启…' : '开启守护进程'),
          ),
          if (watchdogEnabled) ...[
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: watchdogBusy ? null : _stopWatchdog,
              icon: const Icon(Icons.stop),
              label: const Text('关闭守护进程'),
            ),
          ],
        ],
      ),
    ]);
  }

  Widget _buildConnectionTab() {
    final url = selectedAddress == null ? null : 'http://$selectedAddress:3001';
    return _tabScroll([
      _card(
        title: '手机访问地址',
        icon: Icons.wifi_tethering,
        children: [
          const Text('选择手机可以访问的地址（局域网或 Tailscale IPv4）。'),
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
        ],
      ),
      const SizedBox(height: 16),
      _card(
        title: '一次性二维码',
        icon: Icons.qr_code_2_outlined,
        children: [
          if (!running || url == null)
            const Text('先启动后台服务并选择地址，然后即可生成二维码。')
          else ...[
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
                  size: 260,
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
            Center(child: SelectableText(url)),
            const SizedBox(height: 12),
            const Text(
              '安卓基座扫码后可切换已保存的本地和 Tailscale 地址。服务随登录启动，允许 Mac 熄屏；合盖休眠仍会断开。',
              textAlign: TextAlign.center,
            ),
          ],
        ],
      ),
    ]);
  }

  Widget _buildFilesTab() {
    return _tabScroll([
      _card(
        title: '临时文件中转站',
        icon: Icons.swap_horiz_outlined,
        children: [
          const Text(
            '把文件上传到临时中转服务并生成手机可直接打开的下载链接，'
            '避免走 Tailscale 上传。链接会过期，仅用于临时分享。',
          ),
          const SizedBox(height: 12),
          DropdownButtonFormField<RelayProvider>(
            initialValue: relayProvider,
            decoration: const InputDecoration(labelText: '中转服务'),
            items: [
              for (final provider in RelayProvider.values)
                DropdownMenuItem(
                  value: provider,
                  child: Text(provider.label),
                ),
            ],
            onChanged: relayBusy
                ? null
                : (value) {
                    if (value != null) {
                      setState(() => relayProvider = value);
                    }
                  },
          ),
          if (relayPath.isNotEmpty) ...[
            const SizedBox(height: 12),
            SelectableText('文件：$relayPath'),
          ],
          const SizedBox(height: 16),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: relayBusy ? null : _chooseRelayFile,
                icon: const Icon(Icons.folder_open_outlined),
                label: const Text('选择文件'),
              ),
              FilledButton.icon(
                onPressed: relayBusy || relayPath.isEmpty ? null : _uploadRelay,
                icon: const Icon(Icons.cloud_upload_outlined),
                label: Text(relayBusy ? '上传中…' : '上传并生成链接'),
              ),
            ],
          ),
          if (relayBusy) ...[
            const SizedBox(height: 16),
            LinearProgressIndicator(
              value: relayProgress > 0 ? relayProgress : null,
            ),
            const SizedBox(height: 4),
            Text(
              '${(relayProgress * 100).clamp(0, 100).toStringAsFixed(0)}%',
            ),
          ],
          const SizedBox(height: 12),
          SelectableText(relayStatus),
          if (relayResult != null) ...[
            const SizedBox(height: 16),
            SelectableText(relayResult!.url),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              onPressed: _copyRelayLink,
              icon: const Icon(Icons.copy),
              label: const Text('复制链接'),
            ),
            const SizedBox(height: 16),
            Center(
              child: QrImageView(
                data: relayResult!.url,
                size: 200,
                backgroundColor: Colors.white,
              ),
            ),
          ],
        ],
      ),
    ]);
  }

  Widget _buildPermissionsTab() {
    return _tabScroll([
      _card(
        title: '远程使用权限',
        icon: Icons.verified_user_outlined,
        children: [
          const Text(
            '离开 Mac 前检查文件和网络权限，完成后用手机连接一次。'
            'macOS 的授权弹窗必须在电脑上确认。',
          ),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: permissionBusy || selectedAddress == null
                ? null
                : _prepareRemoteAccess,
            icon: const Icon(Icons.verified_user_outlined),
            label: Text(permissionBusy ? '正在检查…' : '检查并准备远程权限'),
          ),
        ],
      ),
      const SizedBox(height: 16),
      _buildDiskAccessCard(),
    ]);
  }
}

/// One program macOS can require in Full Disk Access. Owned by
/// _DesktopConsolePageState and rendered by the disk-access card and the
/// remote-access preparation dialog.
class _DiskAccessTarget {
  const _DiskAccessTarget({
    required this.label,
    required this.path,
    this.isConsole = false,
  });

  /// Display name shown beside the resolved executable path.
  final String label;

  /// Absolute path to the executable or app bundle, or an empty string when it
  /// could not be found on this Mac.
  final String path;

  /// True for this console bundle, whose own Full Disk Access state is the only
  /// one the process can observe directly.
  final bool isConsole;
}
