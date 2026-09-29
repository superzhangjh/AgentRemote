# Agent 遥控台

This project provides an Android Flutter shell for the CloudCLI web interface and a small macOS service console. The Android app keeps a list of local and Tailscale addresses, scans the Mac QR code, displays CloudCLI in a WebView, and receives CloudCLI events through an Android foreground service. The old Agent Remote Gateway and custom Flutter conversation UI have been removed.

CloudCLI source is in [`cloudcli`](cloudcli), based on upstream `v1.37.3`. This checkout adds an Agent filter to both Projects and Conversations and defaults the interface to Simplified Chinese. CloudCLI is licensed under AGPL-3.0-or-later. If you offer a modified instance over a network, make its corresponding source available to its users as the license requires.

## Start the Mac server

Node.js 22 or 24 is recommended. From this directory:

```sh
cd cloudcli
npm ci
npm run build
cd ..
~/fvm/versions/3.47.5/bin/flutter run -d macos
```

Choose a local or Tailscale IPv4 address and click **启动后台服务**. The console installs a per-user LaunchAgent and shows a QR code. After the first start, CloudCLI runs at login and survives closing the console. The service uses `caffeinate -i`, so macOS can turn off the display while CloudCLI remains reachable. Closing a MacBook lid normally puts it to sleep and disconnects the service. Use **停止并取消开机启动** to stop the service and remove its LaunchAgent. Logs are in `~/Library/Logs/AgentRemote/`.

On the first visit to CloudCLI, create an account. CloudCLI connects to installed coding agents directly; there is no separate Gateway to configure.

## Build the Mac release

Run `npm run build` in `cloudcli`, then `flutter build macos --release` and `macos/make_release_dmg.sh` from the project root. The Release app is universal and embeds the current CloudCLI server source, compiled server, and web interface. On its first start, the console copies them to Application Support and installs production dependencies with npm; Node.js 22 or 24 and an internet connection are required for that first installation. Later starts reuse the installed dependencies unless `package-lock.json` changes. An existing manually selected CloudCLI directory remains selected; use **改用应用内置 CloudCLI** to switch to the bundled copy. The DMG includes an Applications shortcut for drag-and-drop installation.

Before using the phone away from the Mac, install the console app in a permanent location and click **检查并准备远程权限**. It starts the service if needed, probes the selected local-network address, and links to Full Disk Access, Local Network, and Firewall settings. Add the displayed console app and Node executable to **Full Disk Access**, enable both, then stop and restart the background service. Connect once from the phone while at the Mac so any incoming-network prompt can be handled. If macOS names a separate agent executable in a file-access prompt, grant that executable access as well. macOS requires approval on the Mac; the phone cannot dismiss its permission dialogs remotely. Grant access only to programs and project folders you trust.

## Android app

Build with Flutter 3.47.5:

```sh
~/fvm/versions/3.47.5/bin/flutter build apk --release
```

Install `build/app/outputs/flutter-apk/app-release.apk`. Scan the Mac QR code or manually enter a full URL. The app remembers addresses and lets you switch between local Wi-Fi and Tailscale addresses from the title menu. A Tailscale IPv4 URL can use `http://100.x.y.z:3001`; a Tailscale HTTPS hostname also works when you configure an HTTPS proxy such as Tailscale Serve.

After logging in, open the notification settings in the Android app and enable **后台通知与常驻连接**. Android will ask for notification permission. The app then shows a persistent notification and maintains CloudCLI's notification connection even when the screen is off. Open **电池优化** in the same settings and set the app to unrestricted for the best background reliability. Notifications follow the currently selected server address.

CloudCLI's user settings include a language selector. This build starts in Simplified Chinese when no language preference has been saved; existing preferences can be changed there.

The self-hosted HTTP port should be used only on a trusted local network or private Tailscale network. Do not publish port 3001 directly to the internet.
