# Agent 遥控台

This project provides an Android Flutter shell for the CloudCLI web interface and a macOS desktop console. The Android app and web interface keep the name **Agent 遥控台**; the macOS desktop console is named **Agent 控制台** to tell the two apart. The Android app keeps a list of local and Tailscale addresses, scans the Mac QR code, displays CloudCLI in a WebView, and receives CloudCLI events through an Android foreground service. The old Agent Remote Gateway and custom Flutter conversation UI have been removed.

CloudCLI source is in [`cloudcli`](cloudcli), based on upstream `v1.37.3`. This checkout adds an Agent filter to both Projects and Conversations and defaults the interface to Simplified Chinese. CloudCLI is licensed under AGPL-3.0-or-later. If you offer a modified instance over a network, make its corresponding source available to its users as the license requires.

## Start the Mac server

Node.js 22 or 24 is recommended. From this directory:

```sh
~/fvm/versions/3.47.5/bin/flutter run -d macos
```

Choose the `cloudcli` project directory, select a local or Tailscale IPv4 address, and click **启动后台服务**. If dependencies are missing, the console runs `npm ci`, then runs `npm run build`, installs a per-user LaunchAgent, and shows a QR code. It reuses an existing npm installation; after changing `package-lock.json`, run `npm ci` once to update dependencies. At login, the LaunchAgent starts the most recently built server; stop and start the service in the console to rebuild after changing source. The service uses `caffeinate -i`, so macOS can turn off the display while CloudCLI remains reachable. Closing a MacBook lid normally puts it to sleep and disconnects the service. Use **停止并取消开机启动** to stop the service and remove its LaunchAgent. Closing the console window hides it without quitting the app: click the Dock icon to bring the same window back, and use ⌘Q to quit. Logs are in `~/Library/Logs/AgentRemote/`.

The console also has an **OpenCode SDK 服务** card. **启动 OpenCode 服务** picks a free port, installs a second per-user LaunchAgent that runs `opencode serve` bound to `0.0.0.0`, and writes the address to `~/.agent-remote/opencode-server.json`; **停止 OpenCode 服务** removes the LaunchAgent and the descriptor. CloudCLI reads the descriptor before every OpenCode turn and attaches with `opencode run --attach`, so sessions reuse the one long-lived server instead of starting a throwaway server per message. Logs are in `~/Library/Logs/AgentRemote/opencode.log` and `opencode-error.log`.

CloudCLI mirrors OpenCode turns started by the desktop app or CLI: the phone shows **等待审批** / **等待回答**, and those approvals are answerable from the phone through the same OpenCode server. A Codex turn started by the Codex desktop app or CLI is different. It is listed as **外部运行中** so the sidebar and phone do not look stuck, but its approvals cannot be answered remotely: the Codex process that started the turn owns the app-server connection that receives them, and a second `codex app-server` cannot take over an in-flight turn. Answer those approvals in the app that started the turn. Approvals for turns CloudCLI itself starts do reach the phone.

The **服务守护进程** card installs a third per-user LaunchAgent that wakes every 60 seconds and at login, probes both managed services, and restarts any of them whose LaunchAgent is still installed but no longer answers. **开启守护进程** installs it and **关闭守护进程** removes it; it only touches services you started from this console. Its log is `~/Library/Logs/AgentRemote/watchdog.log`.

On the first visit to CloudCLI, create an account. CloudCLI connects to installed coding agents directly; there is no separate Gateway to configure.

## Build the Mac release

Run `flutter build macos --release` and `macos/make_release_dmg.sh` from the project root. The Release app contains only the console; it does not bundle CloudCLI. Select a local CloudCLI source directory in the console. Node.js 22 or 24 and npm are required; the console installs missing dependencies with `npm ci` and builds CloudCLI before starting the service. The DMG includes an Applications shortcut for drag-and-drop installation.

Before using the phone away from the Mac, install the console app in a permanent location and click **检查并准备远程权限**. It starts the service if needed, probes the selected local-network address, and links to Full Disk Access, Local Network, and Firewall settings. The **完全磁盘访问** card lists the console app, the background Node executable, and each installed coding agent (Claude, Codex, OpenCode, Cursor); add the programs you use in System Settings → Privacy & Security → Full Disk Access, enable them, then stop and restart the background service. Connect once from the phone while at the Mac so any incoming-network prompt can be handled. If macOS names a separate agent executable in a file-access prompt, grant that executable access as well. macOS requires approval on the Mac; the phone cannot dismiss its permission dialogs remotely. Grant access only to programs and project folders you trust.

## Android app

Build with Flutter 3.47.5. Only build the **release** variant, and only for **ARM64** (`android-arm64`); do not produce debug builds or other ABIs:

```sh
~/fvm/versions/3.47.5/bin/flutter build apk --release --target-platform android-arm64
```

Install `build/app/outputs/flutter-apk/app-release.apk`. Scan the Mac QR code or manually enter a full URL. The app hides the top bar for a full-screen view; shake the phone to open the control panel, where you can switch between local Wi-Fi and Tailscale addresses, scan a QR code, add an address manually, or open notification settings. A Tailscale IPv4 URL can use `http://100.x.y.z:3001`; a Tailscale HTTPS hostname also works when you configure an HTTPS proxy such as Tailscale Serve.

After logging in, open the control panel (shake the phone) and open **后台与通知** to enable **后台通知与常驻连接**. Android will ask for notification permission. The app then shows a persistent notification and maintains CloudCLI's notification connection even when the screen is off. Open **电池优化** in the same settings and set the app to unrestricted for the best background reliability. Notifications follow the currently selected server address.

CloudCLI's user settings include a language selector. This build starts in Simplified Chinese when no language preference has been saved; existing preferences can be changed there.

The self-hosted HTTP port should be used only on a trusted local network or private Tailscale network. Do not publish port 3001 directly to the internet.
