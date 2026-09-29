import Cocoa
import FlutterMacOS
import Security

class MainFlutterWindow: NSWindow {
  private var credentialChannel: FlutterMethodChannel?
  private var consoleChannel: FlutterMethodChannel?

  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = NSRect(x: 0, y: 0, width: 1180, height: 780)
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true, animate: false)
    self.center()

    RegisterGeneratedPlugins(registry: flutterViewController)
    credentialChannel = FlutterMethodChannel(
      name: "agent_remote/credentials",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    credentialChannel?.setMethodCallHandler { [weak self] call, result in
      self?.handleCredentialCall(call, result: result)
    }
    consoleChannel = FlutterMethodChannel(
      name: "agent_remote/console",
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    consoleChannel?.setMethodCallHandler { [weak self] call, result in
      self?.handleConsoleCall(call, result: result)
    }

    super.awakeFromNib()

    if let closeButton = standardWindowButton(.closeButton) {
      closeButton.target = self
      closeButton.action = #selector(minimizeFromCloseButton(_:))
    }
  }

  @objc private func minimizeFromCloseButton(_ sender: Any?) {
    miniaturize(sender)
  }

  private func handleConsoleCall(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    guard call.method == "chooseCloudCliDirectory" else {
      result(FlutterMethodNotImplemented)
      return
    }

    let arguments = call.arguments as? [String: Any]
    let panel = NSOpenPanel()
    panel.title = "选择 CloudCLI 项目目录"
    panel.message = "请选择包含 package.json 和 server 目录的 cloudcli 文件夹。"
    panel.prompt = "选择"
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    if let initialPath = arguments?["initialPath"] as? String {
      panel.directoryURL = URL(fileURLWithPath: initialPath, isDirectory: true)
    }

    panel.beginSheetModal(for: self) { response in
      result(response == .OK ? panel.url?.path : nil)
    }
  }

  private func handleCredentialCall(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "AgentRemote.OpenCode",
      kSecAttrAccount as String: "server-credentials",
    ]

    switch call.method {
    case "read":
      var readQuery = query
      readQuery[kSecReturnData as String] = true
      readQuery[kSecMatchLimit as String] = kSecMatchLimitOne
      var item: CFTypeRef?
      let status = SecItemCopyMatching(readQuery as CFDictionary, &item)
      if status == errSecItemNotFound {
        result(nil)
      } else if status == errSecSuccess, let data = item as? Data {
        result(String(data: data, encoding: .utf8))
      } else {
        result(FlutterError(code: "keychain_read", message: "无法读取 OpenCode 密码", details: Int(status)))
      }

    case "write":
      guard let value = call.arguments as? String else {
        result(FlutterError(code: "keychain_write", message: "密码格式无效", details: nil))
        return
      }
      var addQuery = query
      addQuery[kSecValueData as String] = Data(value.utf8)
      var status = SecItemAdd(addQuery as CFDictionary, nil)
      if status == errSecDuplicateItem {
        status = SecItemUpdate(
          query as CFDictionary,
          [kSecValueData as String: Data(value.utf8)] as CFDictionary
        )
      }
      if status == errSecSuccess {
        result(nil)
      } else {
        result(FlutterError(code: "keychain_write", message: "无法保存 OpenCode 密码", details: Int(status)))
      }

    default:
      result(FlutterMethodNotImplemented)
    }
  }
}
