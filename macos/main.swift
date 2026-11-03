// PCB Scope — native macOS shell.
// A window with a WKWebView that runs the web app from the bundle. The page is served by a tiny
// loopback HTTP server, because camera access and Web Workers need a secure http(s) origin.
//
// Build: macos/build.sh  (universal binary, .app bundle, .dmg)

import AppKit
import Network
import UniformTypeIdentifiers
import WebKit

let repoURL = URL(string: "https://github.com/dhritiman-dasgupta/pcb-scope")!

// MARK: - Loopback static file server

final class StaticServer {
    private let root: URL
    private var extra: [String: URL] = [:]
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "pcbscope.http", attributes: .concurrent)

    init(root: URL) { self.root = root.standardizedFileURL }

    /// Serve an extra file at a fixed path (used by --selftest).
    func mount(_ path: String, file: URL) { extra[path] = file }

    /// Bind 127.0.0.1 on the preferred port (keeps localStorage stable between launches), else any port.
    func start(preferred: UInt16) -> UInt16? {
        for candidate in [preferred, 0] {
            let params = NWParameters.tcp
            params.requiredInterfaceType = .loopback
            params.allowLocalEndpointReuse = true
            guard let port = NWEndpoint.Port(rawValue: candidate),
                  let l = try? NWListener(using: params, on: port) else { continue }
            let sem = DispatchSemaphore(value: 0)
            var ready = false
            l.stateUpdateHandler = { state in
                switch state {
                case .ready: ready = true; sem.signal()
                case .failed, .cancelled: sem.signal()
                default: break
                }
            }
            l.newConnectionHandler = { [weak self] c in self?.accept(c) }
            l.start(queue: queue)
            _ = sem.wait(timeout: .now() + 3)
            if ready, let p = l.port?.rawValue { listener = l; return p }
            l.cancel()
        }
        return nil
    }

    private func accept(_ c: NWConnection) {
        c.start(queue: queue)
        receive(c, Data())
    }

    private func receive(_ c: NWConnection, _ buffer: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, error in
            guard let self else { c.cancel(); return }
            var buf = buffer
            if let data { buf.append(data) }
            if let r = buf.range(of: Data("\r\n\r\n".utf8)) {
                self.respond(c, head: String(decoding: buf[..<r.lowerBound], as: UTF8.self))
            } else if done || error != nil || buf.count > 65536 {
                c.cancel()
            } else {
                self.receive(c, buf)
            }
        }
    }

    private func respond(_ c: NWConnection, head: String) {
        let parts = head.split(separator: "\r\n").first?.split(separator: " ") ?? []
        guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else { return send(c, 405, "text/plain", Data("method not allowed".utf8)) }
        var path = String(parts[1].split(separator: "?", maxSplits: 1).first ?? "/")
        path = path.removingPercentEncoding ?? path
        if path == "/" { path = "/index.html" }
        let file: URL
        if let mounted = extra[path] {
            file = mounted
        } else {
            if path.split(separator: "/").contains("..") { return send(c, 403, "text/plain", Data("forbidden".utf8)) }
            file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
            guard file.path.hasPrefix(root.path + "/") else { return send(c, 403, "text/plain", Data("forbidden".utf8)) }
        }
        guard let body = try? Data(contentsOf: file) else { return send(c, 404, "text/plain", Data("not found".utf8)) }
        send(c, 200, mime(file.pathExtension), parts[0] == "HEAD" ? Data() : body, length: body.count)
    }

    private func send(_ c: NWConnection, _ status: Int, _ type: String, _ body: Data, length: Int? = nil) {
        let reason = [200: "OK", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed"][status] ?? "OK"
        var out = Data("HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(length ?? body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n".utf8)
        out.append(body)
        c.send(content: out, completion: .contentProcessed { _ in c.cancel() })
    }

    private func mime(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "wasm": return "application/wasm"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: StaticServer!
    var port: UInt16 = 0
    var downloads: [ObjectIdentifier: URL] = [:]
    var selftest: (image: URL, out: URL)?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--selftest"), args.count > i + 2 {
            selftest = (URL(fileURLWithPath: args[i + 1]), URL(fileURLWithPath: args[i + 2]))
        }
        buildMenu()

        let root = Bundle.main.resourceURL!.appendingPathComponent("web")
        server = StaticServer(root: root)
        if let st = selftest { server.mount("/__selftest/image." + st.image.pathExtension, file: st.image) }
        guard let p = server.start(preferred: 8791) else {
            let a = NSAlert(); a.messageText = "PCB Scope could not start its local server."; a.runModal()
            NSApp.terminate(nil); return
        }
        port = p

        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: cfg)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        if #available(macOS 13.3, *) { webView.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "PCB Scope"
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("PCBScopeMainWindow")
        window.makeKeyAndOrderFront(nil)

        var url = "http://127.0.0.1:\(port)/"
        if let st = selftest { url += "?img=/__selftest/image.\(st.image.pathExtension)&nocam" }
        webView.load(URLRequest(url: URL(string: url)!))
        NSApp.activate(ignoringOtherApps: true)
        if selftest != nil { runSelftest() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: Menu

    private func buildMenu() {
        let main = NSMenu()
        func menu(_ title: String, _ items: [NSMenuItem]) {
            let top = NSMenuItem(); let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            top.submenu = m; main.addItem(top)
        }
        func item(_ t: String, _ a: Selector?, _ k: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i
        }
        menu("PCB Scope", [
            item("About PCB Scope", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            item("Hide PCB Scope", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit PCB Scope", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        menu("View", [
            item("Reload", #selector(reloadPage), "r"),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        menu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
        ])
        menu("Help", [
            item("PCB Scope on GitHub", #selector(openRepo)),
            item("Open Saved Files Folder", #selector(openSaves)),
        ])
        NSApp.mainMenu = main
    }

    @objc func reloadPage() { webView.reload() }
    @objc func openRepo() { NSWorkspace.shared.open(repoURL) }
    @objc func openSaves() {
        let dir = savesDir()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dir)
    }
    private func savesDir() -> URL {
        FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0].appendingPathComponent("PCB Scope", isDirectory: true)
    }

    // MARK: Camera permission

    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" && type == .camera ? .grant : .deny)
    }

    // MARK: Navigation, links, downloads

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if let url = action.request.url, let scheme = url.scheme,
           (scheme == "http" || scheme == "https"), url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = savesDir()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = (suggestedFilename as NSString).deletingPathExtension, ext = (suggestedFilename as NSString).pathExtension
        var dest = dir.appendingPathComponent(suggestedFilename)
        var n = 2
        while FileManager.default.fileExists(atPath: dest.path) { dest = dir.appendingPathComponent("\(name) \(n).\(ext)"); n += 1 }
        downloads[ObjectIdentifier(download)] = dest
        completionHandler(dest)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let dest = downloads.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let shown = "~/Downloads/PCB Scope/" + dest.lastPathComponent
        let js = "window.__pcbscopeNativeSaved && window.__pcbscopeNativeSaved(\(jsString(shown)))"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        NSSound.beep()
    }

    // target=_blank and window.open → default browser
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: JS panels and <input type=file>

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image]
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message
        a.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        a.window.initialFirstResponder = field
        a.beginSheetModal(for: window) { r in completionHandler(r == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    // MARK: Self-test (CI / build check): load an image, print the detection summary, save a snapshot.

    private func runSelftest() {
        let js = """
        (() => { const s = window.__pcbscope && window.__pcbscope.st; if (!s) return JSON.stringify({ ok: false });
          const c = {}; s.dets.forEach(d => c[d.c] = (c[d.c] || 0) + 1);
          return JSON.stringify({ ok: !!s.mask, secure: window.isSecureContext, camApi: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
            vfc: 'requestVideoFrameCallback' in HTMLVideoElement.prototype, perf: document.querySelector('#perfChip').textContent,
            counts: c, labels: s.dets.filter(d => ['ic','res','cap','part'].includes(d.c)).map(d => d.label) }); })()
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
            self.webView.evaluateJavaScript(js) { result, error in
                print(result as? String ?? "error: \(String(describing: error))")
                self.webView.takeSnapshot(with: nil) { image, _ in
                    if let image, let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                       let png = rep.representation(using: .png, properties: [:]) {
                        try? png.write(to: self.selftest!.out)
                    }
                    fflush(stdout)
                    NSApp.terminate(nil)
                }
            }
        }
    }
}

func jsString(_ s: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [s])
    let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(arr.dropFirst().dropLast())
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
