import UIKit
import WebKit

@MainActor final class WebController: UIViewController, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private let auth = TangoAuth()
    private lazy var relay = MediaRelay(auth:auth)
    private var webView: WKWebView!
    private var timer: Task<Void,Never>?
    private var activeDocument = ""
    private var cold = true
    private var started = false
    private var loginView: UIStackView?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private let stateURL = FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("StreamViewer/view.json")
    private var checkpoint: [String:Any] = [:]

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override func viewDidLoad() {
        super.viewDidLoad()
        if let data = try? Data(contentsOf:stateURL), let state = try? JSONSerialization.jsonObject(with:data) as? [String:Any] { checkpoint = state }
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(LocalFiles(),forURLScheme:"streamviewer")
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"viewer")
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.ignoresViewportScaleLimits = true
        webView = WKWebView(frame:.zero,configuration:config)
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        view.backgroundColor = .black
        view.addSubview(webView)
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); webView.frame = view.bounds }
    func capture() { webView?.evaluateJavaScript("window.streamViewerApp?.save()",completionHandler:nil) }
    func pause() {
        timer?.cancel(); timer = nil
        webView.evaluateJavaScript("dispatchEvent(new Event('viewer-background'))",completionHandler:nil)
        // Allow an already-started rotation to persist its replacement before
        // suspension. Cancelling a consumed RT request would lose that response.
        backgroundTask = UIApplication.shared.beginBackgroundTask { [weak self] in self?.endBackgroundTask() }
        Task { await auth.finishPendingRefresh(); endBackgroundTask() }
    }
    private func endBackgroundTask() {
        if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid }
    }
    func resume() {
        guard isViewLoaded, timer == nil else { return }
        timer = Task { [weak self] in
            guard let self else { return }
            var foreground = true
            while !Task.isCancelled {
                do {
                    try await authenticate()
                    if Task.isCancelled { break }
                    loginView?.removeFromSuperview(); loginView = nil; webView.isHidden = false
                    if !started {
                        started = true
                        webView.load(URLRequest(url:URL(string:"streamviewer://app/")!))
                    } else if foreground {
                        webView.evaluateJavaScript("dispatchEvent(new Event('viewer-foreground'))",completionHandler:nil)
                    }
                    foreground = false
                } catch {
                    if let failure = error as? AuthFailure {
                        switch failure { case .login, .pending: showLogin(failure.localizedDescription); default: if !started { showLogin(failure.localizedDescription) } }
                    } else if !started { showLogin("Could not connect to Tango. Retrying…") }
                }
                do { try await Task.sleep(nanoseconds:5_000_000_000) } catch { break }
            }
        }
    }
    private func authenticate() async throws {
        _ = try await auth.authenticate()
        try await relay.start()
    }
    private func showLogin(_ message: String) {
        guard loginView == nil else { return }
        webView.isHidden = true
        let label = UILabel(); label.numberOfLines = 0
        label.text = message + "\n\nSign in with Google on Tango in Safari. Enable Tango Login and choose Import login into Tango. Close Tango tabs, then delete only Tango in Safari’s Website Data settings."
        let open = UIButton(type:.system); open.setTitle("Open Tango in Safari",for:.normal)
        open.addTarget(self,action:#selector(openSafari),for:.touchUpInside)
        let confirm = UIButton(type:.system); confirm.setTitle("Safari data cleared — continue",for:.normal)
        confirm.addTarget(self,action:#selector(confirmLogin),for:.touchUpInside)
        let stack = UIStackView(arrangedSubviews:[label,open,confirm]); stack.axis = .vertical; stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo:view.leadingAnchor,constant:24),stack.trailingAnchor.constraint(equalTo:view.trailingAnchor,constant:-24),stack.centerYAnchor.constraint(equalTo:view.centerYAnchor)])
        loginView = stack
    }
    @objc private func openSafari() { UIApplication.shared.open(URL(string:"https://www.tango.me/")!) }
    @objc private func confirmLogin() {
        do {
            if var login = try LoginStore.load(), login.handoffComplete != true {
                login.handoffComplete = true; try LoginStore.save(login)
            }
            timer?.cancel(); timer = nil; resume()
        } catch { (loginView?.arrangedSubviews.first as? UILabel)?.text = error.localizedDescription }
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?,String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.scheme == "streamviewer",
              message.frameInfo.request.url?.host == "app", let body = message.body as? [String:Any],
              let command = body["command"] as? String else { replyHandler(nil,"Invalid native request"); return }
        let args = body["args"] as? [String:Any] ?? [:]
        let document = args["document"] as? String ?? ""
        Task {
            do {
                switch command {
                case "init":
                    activeDocument = document
                    var state = checkpoint; state["cold"] = cold; cold = false
                    replyHandler(String(decoding:try JSONSerialization.data(withJSONObject:state),as:UTF8.self),nil)
                case "activate": activeDocument = document; replyHandler("{}",nil)
                case "save":
                    guard activeDocument == document else { replyHandler("{}",nil); return }
                    guard let path = args["path"] as? String, path == "/" || path.hasPrefix("/stream/"),
                          let current = args["currentStreamerId"] as? String,
                          let y = args["homeY"] as? Double, y.isFinite, y >= 0,
                          let multi = args["multi"] as? String, ["on","off"].contains(multi) else { throw AuthFailure.invalid }
                    checkpoint = ["path":path,"currentStreamerId":current,"homeY":y,"multi":multi]
                    try FileManager.default.createDirectory(at:stateURL.deletingLastPathComponent(),withIntermediateDirectories:true)
                    try JSONSerialization.data(withJSONObject:checkpoint).write(to:stateURL,options:.atomic)
                    replyHandler("{}",nil)
                case "authenticate": try await authenticate(); replyHandler("{}",nil)
                case "media":
                    guard let url = args["url"] as? String else { throw AuthFailure.invalid }
                    let source = try await relay.resolve(url)
                    replyHandler(String(decoding:try JSONSerialization.data(withJSONObject:["url":source,"quality":""]),as:UTF8.self),nil)
                case "request": replyHandler(try await auth.request(JSONSerialization.data(withJSONObject:args)),nil)
                case "diagnostics":
                    let status: [String:Any] = ["refreshes":await auth.refreshCount,"playbackUpdates":await auth.playbackCount,
                        "mediaHTTP":Dictionary(uniqueKeysWithValues:await relay.statuses.map { (String($0.key),$0.value) })]
                    replyHandler(String(decoding:try JSONSerialization.data(withJSONObject:status),as:UTF8.self),nil)
                default: replyHandler(nil,"Unknown native request")
                }
            } catch { replyHandler(nil,error.localizedDescription) }
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url?.scheme == "streamviewer" && url?.host == "app" ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        cold = true; webView.load(URLRequest(url:URL(string:"streamviewer://app/")!))
    }
}

@MainActor final class LocalFiles: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app" else { return }
        let name = url.path == "/app.js" ? "app.js" : "index.html"
        do {
            let resource = Bundle.main.resourceURL!.appendingPathComponent("Web/"+name)
            let data = try Data(contentsOf:resource)
            task.didReceive(URLResponse(url:url,mimeType:name.hasSuffix(".js") ? "application/javascript" : "text/html",expectedContentLength:data.count,textEncodingName:"utf-8"))
            task.didReceive(data); task.didFinish()
        } catch { task.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
