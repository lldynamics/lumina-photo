import AppKit
import Foundation

struct LanAddressPayload: Codable, Sendable {
  let url: String
  let interfaceName: String?
}

struct TrayMessage: Codable, Sendable {
  let type: String?
  let status: String?
  let port: Int?
  let url: String?
  let openUrl: String?
  let localUrl: String?
  let lanUrl: String?
  let mdnsUrl: String?
  let publicUrl: String?
  let tailscaleUrl: String?
  let lanAddresses: [LanAddressPayload]?
  let dataDir: String?
  let logFile: String?
  let autostart: Bool?
  let error: String?
}

struct BundleConfig: Codable {
  let projectDir: String?
  let nodePath: String?
}

final class ActionBox: NSObject {
  let handler: () -> Void
  init(_ handler: @escaping () -> Void) {
    self.handler = handler
    super.init()
  }
  @objc func invoke(_ sender: Any?) {
    handler()
  }
}

final class LuminaTrayController: NSObject, NSApplicationDelegate {
  private let isIpcMode: Bool
  private let openOnReady: Bool

  private var statusItem: NSStatusItem!
  private let menu = NSMenu()
  private var actionBoxes: [ActionBox] = []

  private var currentStatus = "starting"
  private var currentPort: Int?
  private var currentOpenUrl: String?
  private var currentLocalUrl: String?
  private var currentLanUrl: String?
  private var currentMdnsUrl: String?
  private var currentPublicUrl: String?
  private var currentTailscaleUrl: String?
  private var currentLanAddresses: [LanAddressPayload] = []
  private var currentDataDir: String?
  private var currentLogFile: String?
  private var currentAutostart = false
  private var currentError: String?
  private var copiedFeedback: String?

  private var supervisorProcess: Process?
  private var supervisorWriteHandle: FileHandle?
  private var stderrTail = ""
  private var isQuitting = false
  private var receivedAlreadyRunning = false

  private var sigintSource: DispatchSourceSignal?
  private var sigtermSource: DispatchSourceSignal?

  init(isIpcMode: Bool, openOnReady: Bool) {
    self.isIpcMode = isIpcMode
    self.openOnReady = openOnReady
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)

    menu.autoenablesItems = false
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    statusItem.menu = menu

    installSignalHandlers()
    updateStatusIcon()
    rebuildMenu()

    if isIpcMode {
      startReadingHandle(FileHandle.standardInput)
    } else {
      launchStandaloneSupervisor()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    if !isIpcMode && !receivedAlreadyRunning, let proc = supervisorProcess, proc.isRunning {
      sendAction(["action": "quit"])
      proc.terminate()
    }
  }

  private func installSignalHandlers() {
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)

    let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    sigint.setEventHandler { [weak self] in
      self?.handleSignalTermination()
    }
    sigint.resume()
    sigintSource = sigint

    let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    sigterm.setEventHandler { [weak self] in
      self?.handleSignalTermination()
    }
    sigterm.resume()
    sigtermSource = sigterm
  }

  private func handleSignalTermination() {
    if isIpcMode {
      NSApp.terminate(nil)
      return
    }
    triggerQuit()
  }

  private func startReadingHandle(_ handle: FileHandle) {
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var buffer = Data()
      while true {
        let chunk = handle.availableData
        if chunk.isEmpty {
          DispatchQueue.main.async {
            self?.handleInputEof()
          }
          break
        }
        buffer.append(chunk)
        while let newlineIndex = buffer.firstIndex(of: 0x0A) {
          let lineData = buffer.subdata(in: 0..<newlineIndex)
          buffer.removeSubrange(0...newlineIndex)
          guard !lineData.isEmpty else { continue }
          if let msg = try? JSONDecoder().decode(TrayMessage.self, from: lineData) {
            DispatchQueue.main.async {
              self?.handleMessage(msg)
            }
          }
        }
      }
    }
  }

  private func startReadingStderr(_ handle: FileHandle) {
    DispatchQueue.global(qos: .utility).async { [weak self] in
      while true {
        let chunk = handle.availableData
        if chunk.isEmpty { break }
        if let text = String(data: chunk, encoding: .utf8), !text.isEmpty {
          DispatchQueue.main.async {
            guard let self else { return }
            self.stderrTail.append(text)
            if self.stderrTail.count > 4000 {
              self.stderrTail = String(self.stderrTail.suffix(4000))
            }
          }
        }
      }
    }
  }

  private func handleInputEof() {
    if isIpcMode {
      NSApp.terminate(nil)
    }
  }

  private func handleMessage(_ msg: TrayMessage) {
    if msg.type == "shutdown" {
      NSApp.terminate(nil)
      return
    }
    if msg.type == "alreadyRunning" {
      receivedAlreadyRunning = true
      NSApp.terminate(nil)
      return
    }

    if let status = msg.status { currentStatus = status }
    if let port = msg.port { currentPort = port }
    currentOpenUrl = msg.openUrl ?? msg.url ?? currentOpenUrl
    currentLocalUrl = msg.localUrl
    currentLanUrl = msg.lanUrl
    currentMdnsUrl = msg.mdnsUrl
    currentPublicUrl = msg.publicUrl
    currentTailscaleUrl = msg.tailscaleUrl
    if let addrs = msg.lanAddresses {
      currentLanAddresses = addrs
    }
    if let dir = msg.dataDir { currentDataDir = dir }
    if let logFile = msg.logFile { currentLogFile = logFile }
    if let autostart = msg.autostart { currentAutostart = autostart }
    currentError = msg.error

    updateStatusIcon()
    rebuildMenu()
  }

  private func sendAction(_ payload: [String: String]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
      return
    }
    var line = data
    line.append(0x0A)

    if isIpcMode {
      FileHandle.standardOutput.write(line)
      return
    }

    if let handle = supervisorWriteHandle {
      do {
        try handle.write(contentsOf: line)
      } catch {
        // Pipe closed
      }
    }
  }

  private func makeFallbackIcon() -> NSImage {
    let size = NSSize(width: 18, height: 18)
    let img = NSImage(size: size, flipped: false) { _ in
      let rect = NSRect(x: 2.5, y: 3.5, width: 13, height: 11)
      let outer = NSBezierPath(roundedRect: rect, xRadius: 2.2, yRadius: 2.2)
      outer.lineWidth = 1.4
      NSColor.black.setStroke()
      outer.stroke()

      let sun = NSBezierPath(ovalIn: NSRect(x: 5.0, y: 9.8, width: 2.4, height: 2.4))
      NSColor.black.setFill()
      sun.fill()

      let mountain = NSBezierPath()
      mountain.move(to: NSPoint(x: 4.0, y: 5.0))
      mountain.line(to: NSPoint(x: 7.4, y: 8.8))
      mountain.line(to: NSPoint(x: 10.0, y: 6.4))
      mountain.line(to: NSPoint(x: 12.2, y: 9.2))
      mountain.line(to: NSPoint(x: 14.3, y: 5.0))
      mountain.close()
      mountain.fill()
      return true
    }
    img.isTemplate = true
    return img
  }

  private func symbolImage(named name: String, accessibility: String) -> NSImage {
    if let img = NSImage(systemSymbolName: name, accessibilityDescription: accessibility) {
      let config = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
      let configured = img.withSymbolConfiguration(config) ?? img
      configured.isTemplate = true
      return configured
    }
    return makeFallbackIcon()
  }

  private func updateStatusIcon() {
    guard let button = statusItem.button else { return }
    let img: NSImage
    switch currentStatus {
    case "error":
      img = symbolImage(named: "exclamationmark.triangle", accessibility: "相册服务异常")
    case "building", "starting", "restarting":
      img = symbolImage(named: "arrow.triangle.2.circlepath", accessibility: "相册正在启动")
    default:
      img = symbolImage(named: "photo.on.rectangle.angled", accessibility: "自己用的一个相册")
    }
    button.image = img
    button.imagePosition = .imageOnly

    switch currentStatus {
    case "running":
      if let port = currentPort {
        button.toolTip = "自己用的一个相册 · 运行中 (端口 \(port))"
      } else {
        button.toolTip = "自己用的一个相册 · 运行中"
      }
    case "building":
      button.toolTip = "自己用的一个相册 · 正在准备运行环境..."
    case "restarting":
      button.toolTip = "自己用的一个相册 · 正在重启..."
    case "error":
      button.toolTip = "自己用的一个相册 · 启动失败"
    default:
      button.toolTip = "自己用的一个相册 · 正在启动..."
    }
  }

  private func addDisabledLabel(_ title: String) {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    menu.addItem(item)
  }

  private func addActionItem(
    _ title: String,
    keyEquivalent: String = "",
    enabled: Bool = true,
    checked: Bool = false,
    handler: @escaping () -> Void
  ) {
    let box = ActionBox(handler)
    actionBoxes.append(box)
    let item = NSMenuItem(
      title: title,
      action: #selector(ActionBox.invoke(_:)),
      keyEquivalent: keyEquivalent
    )
    item.target = box
    item.isEnabled = enabled
    item.state = checked ? .on : .off
    menu.addItem(item)
  }

  private func copyToPasteboard(_ url: String, feedbackLabel: String) {
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(url, forType: .string)
    copiedFeedback = feedbackLabel
    rebuildMenu()
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
      guard let self, self.copiedFeedback == feedbackLabel else { return }
      self.copiedFeedback = nil
      self.rebuildMenu()
    }
  }

  private func rebuildMenu() {
    menu.removeAllItems()
    actionBoxes.removeAll()

    let statusText: String
    if isQuitting {
      statusText = "◐ 自己用的一个相册 · 正在安全关闭..."
    } else {
      switch currentStatus {
      case "running":
        if let port = currentPort {
          statusText = "● 自己用的一个相册 · 运行中 (端口 \(port))"
        } else {
          statusText = "● 自己用的一个相册 · 运行中"
        }
      case "building":
        statusText = "◐ 正在检查并构建前端资源..."
      case "restarting":
        statusText = "◐ 正在重启相册服务..."
      case "error":
        statusText = "▲ 服务启动失败"
      default:
        statusText = "◐ 正在启动相册服务..."
      }
    }
    addDisabledLabel(statusText)

    if currentStatus == "error", let err = currentError, !err.isEmpty {
      let compact = err.count > 68 ? String(err.prefix(65)) + "..." : err
      addDisabledLabel("  原因: \(compact)")
    } else if let openUrl = currentOpenUrl, currentStatus == "running" {
      addDisabledLabel("  地址: \(openUrl)")
    }

    if let feedback = copiedFeedback {
      addDisabledLabel("✓ \(feedback)")
    }

    menu.addItem(.separator())

    addActionItem(
      "打开相册",
      keyEquivalent: "o",
      enabled: currentStatus == "running" && currentOpenUrl != nil && !isQuitting
    ) { [weak self] in
      guard let self else { return }
      if let raw = self.currentOpenUrl,
         let url = URL(string: raw),
         NSWorkspace.shared.open(url) {
        return
      }
      self.sendAction(["action": "open"])
    }

    if let localUrl = currentLocalUrl {
      addActionItem("复制本机地址 (\(localUrl))", enabled: !isQuitting) { [weak self] in
        self?.copyToPasteboard(localUrl, feedbackLabel: "已复制本机地址")
      }
    }

    var remoteAdded = false
    if let publicUrl = currentPublicUrl {
      remoteAdded = true
      addActionItem("复制公网地址 (\(publicUrl))", enabled: !isQuitting) { [weak self] in
        self?.copyToPasteboard(publicUrl, feedbackLabel: "已复制公网地址")
      }
    }

    if let lanUrl = currentLanUrl {
      remoteAdded = true
      let iface = currentLanAddresses.first?.interfaceName
      let suffix = (iface != nil && !iface!.isEmpty) ? " · \(iface!)" : ""
      addActionItem("复制局域网地址 (\(lanUrl)\(suffix))", enabled: !isQuitting) { [weak self] in
        self?.copyToPasteboard(lanUrl, feedbackLabel: "已复制局域网地址")
      }
    } else if let mdnsUrl = currentMdnsUrl {
      remoteAdded = true
      addActionItem("复制局域网域名 (\(mdnsUrl))", enabled: !isQuitting) { [weak self] in
        self?.copyToPasteboard(mdnsUrl, feedbackLabel: "已复制局域网域名")
      }
    }

    if let tailscaleUrl = currentTailscaleUrl {
      remoteAdded = true
      addActionItem("复制 Tailscale 地址 (\(tailscaleUrl))", enabled: !isQuitting) { [weak self] in
        self?.copyToPasteboard(tailscaleUrl, feedbackLabel: "已复制 Tailscale 地址")
      }
    }

    if currentStatus == "running" && !remoteAdded {
      addDisabledLabel("  局域网未开放（当前仅限本机访问）")
    }

    menu.addItem(.separator())

    addActionItem(
      "开机自动启动",
      enabled: !isQuitting,
      checked: currentAutostart
    ) { [weak self] in
      self?.sendAction(["action": "toggleAutostart"])
    }

    addActionItem(
      "打开数据目录",
      enabled: !isQuitting && currentDataDir != nil
    ) { [weak self] in
      self?.sendAction(["action": "openDataDir"])
    }

    addActionItem(
      "查看运行日志",
      enabled: !isQuitting
    ) { [weak self] in
      self?.sendAction(["action": "openLogs"])
    }

    menu.addItem(.separator())

    addActionItem("重启服务", enabled: !isQuitting) { [weak self] in
      guard let self else { return }
      self.currentStatus = "restarting"
      self.updateStatusIcon()
      self.rebuildMenu()
      self.sendAction(["action": "restart"])
    }

    addActionItem("退出相册", keyEquivalent: "q", enabled: !isQuitting) { [weak self] in
      self?.triggerQuit()
    }
  }

  private func triggerQuit() {
    if isQuitting { return }
    isQuitting = true
    rebuildMenu()

    if isIpcMode {
      sendAction(["action": "quit"])
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
        NSApp.terminate(nil)
      }
      return
    }

    guard let proc = supervisorProcess, proc.isRunning else {
      NSApp.terminate(nil)
      return
    }

    sendAction(["action": "quit"])
    DispatchQueue.main.asyncAfter(deadline: .now() + 6.0) { [weak self] in
      guard let self else { return }
      if let p = self.supervisorProcess, p.isRunning {
        p.terminate()
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
        NSApp.terminate(nil)
      }
    }
  }

  private func loadBundleConfig() -> BundleConfig? {
    guard let resUrl = Bundle.main.resourceURL else { return nil }
    let cfgUrl = resUrl.appendingPathComponent("config.json")
    guard let data = try? Data(contentsOf: cfgUrl) else { return nil }
    return try? JSONDecoder().decode(BundleConfig.self, from: data)
  }

  private func hasStartScript(_ dir: String) -> Bool {
    let candidate = URL(fileURLWithPath: dir).appendingPathComponent("scripts/start.mjs").path
    return FileManager.default.isReadableFile(atPath: candidate)
  }

  private func resolveProjectDir(config: BundleConfig?) -> String? {
    if let envDir = ProcessInfo.processInfo.environment["LUMINA_PROJECT_DIR"],
       hasStartScript(envDir) {
      return envDir
    }
    let bundleParent = URL(fileURLWithPath: Bundle.main.bundlePath).deletingLastPathComponent().path
    if hasStartScript(bundleParent) {
      return bundleParent
    }
    if let cfgDir = config?.projectDir, hasStartScript(cfgDir) {
      return cfgDir
    }
    return nil
  }

  private func findNodeCandidatesInGlobDir(_ baseDir: String) -> [String] {
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(atPath: baseDir) else { return [] }
    return entries
      .sorted { $0.localizedStandardCompare($1) == .orderedDescending }
      .map { entry in
        URL(fileURLWithPath: baseDir).appendingPathComponent(entry).appendingPathComponent("bin/node").path
      }
  }

  private func resolveNodePath(config: BundleConfig?) -> String? {
    let fm = FileManager.default
    let home = NSHomeDirectory()
    var candidates: [String] = []

    if let envNode = ProcessInfo.processInfo.environment["LUMINA_NODE_PATH"] {
      candidates.append(envNode)
    }
    if let cfgNode = config?.nodePath {
      candidates.append(cfgNode)
    }
    candidates.append(contentsOf: findNodeCandidatesInGlobDir("\(home)/.local/opt"))
    candidates.append(contentsOf: findNodeCandidatesInGlobDir("\(home)/.nvm/versions/node"))
    candidates.append(contentsOf: [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "\(home)/.local/bin/node",
      "/usr/bin/node",
    ])
    if let pathEnv = ProcessInfo.processInfo.environment["PATH"] {
      for dir in pathEnv.split(separator: ":") {
        candidates.append("\(dir)/node")
      }
    }

    for candidate in candidates where !candidate.isEmpty {
      if fm.isExecutableFile(atPath: candidate) {
        return candidate
      }
    }
    return nil
  }

  private func showFatalAlert(title: String, message: String) {
    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.alertStyle = .critical
    alert.messageText = title
    alert.informativeText = message
    alert.addButton(withTitle: "好")
    alert.runModal()
    NSApp.terminate(nil)
  }

  private func launchStandaloneSupervisor() {
    let bundledProjectDir = Bundle.main.resourceURL?.appendingPathComponent("app").path
    let embeddedProject = bundledProjectDir.flatMap { hasStartScript($0) ? $0 : nil }
    let config = embeddedProject == nil ? loadBundleConfig() : nil
    guard let projectDir = embeddedProject ?? resolveProjectDir(config: config) else {
      showFatalAlert(
        title: "找不到相册项目目录",
        message: "未能定位包含 scripts/start.mjs 的项目文件夹。请回到项目目录重新运行 npm run desktop:install。"
      )
      return
    }
    let bundledNode = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/node").path
    let runtime = embeddedProject == nil ? resolveNodePath(config: config) : bundledNode
    guard let nodePath = runtime, FileManager.default.isExecutableFile(atPath: nodePath) else {
      showFatalAlert(
        title: "未找到 Node.js",
        message: "找不到可用的 Node.js。请重新解压下载包，或为源码版安装 Node.js 22.16+ 或 24+。"
      )
      return
    }

    let startScript = URL(fileURLWithPath: projectDir)
      .appendingPathComponent("scripts/start.mjs").path
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: nodePath)
    proc.currentDirectoryURL = URL(fileURLWithPath: projectDir)
    proc.arguments = [
      startScript,
      "--managed-by-tray",
      openOnReady ? "--open-on-ready" : "--no-open",
      "--app-bundle-path",
      Bundle.main.bundlePath,
    ]

    if embeddedProject != nil {
      proc.arguments?.append("--bundled-runtime")
    }
    var env = ProcessInfo.processInfo.environment
    let home = NSHomeDirectory()
    let extraPaths = [
      URL(fileURLWithPath: nodePath).deletingLastPathComponent().path,
      "\(home)/.local/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]
    let currentPath = env["PATH"] ?? ""
    var seen = Set<String>()
    let mergedPath = (extraPaths + currentPath.split(separator: ":").map(String.init))
      .filter { !$0.isEmpty && seen.insert($0).inserted }
      .joined(separator: ":")
    env["PATH"] = mergedPath
    proc.environment = env

    let inPipe = Pipe()
    let outPipe = Pipe()
    let errPipe = Pipe()
    proc.standardInput = inPipe
    proc.standardOutput = outPipe
    proc.standardError = errPipe

    supervisorProcess = proc
    supervisorWriteHandle = inPipe.fileHandleForWriting

    startReadingHandle(outPipe.fileHandleForReading)
    startReadingStderr(errPipe.fileHandleForReading)

    proc.terminationHandler = { [weak self] finishedProc in
      DispatchQueue.main.async {
        guard let self else { return }
        self.supervisorProcess = nil
        self.supervisorWriteHandle = nil
        if self.isQuitting || finishedProc.terminationStatus == 0 {
          NSApp.terminate(nil)
          return
        }
        self.currentStatus = "error"
        if self.currentError == nil || self.currentError?.isEmpty == true {
          let tail = self.stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)
          self.currentError = tail.isEmpty
            ? "后台进程意外退出 (退出码 \(finishedProc.terminationStatus))"
            : tail.components(separatedBy: .newlines).last
        }
        self.updateStatusIcon()
        self.rebuildMenu()
      }
    }

    do {
      try proc.run()
    } catch {
      showFatalAlert(
        title: "无法启动相册后台进程",
        message: error.localizedDescription
      )
    }
  }
}

let args = CommandLine.arguments
let ipcMode = args.contains("--ipc")
let noOpen = args.contains("--no-open") || args.contains("--autostart")

let app = NSApplication.shared
let controller = LuminaTrayController(isIpcMode: ipcMode, openOnReady: !noOpen)
app.delegate = controller
app.run()
