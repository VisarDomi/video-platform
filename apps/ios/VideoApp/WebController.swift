import UIKit
import WebKit

// A full-screen Safari tab. Local apps show one provider's videos on the PC; the
// page, API and HLS come from the PC exactly as in Safari, and the phone already
// trusts its certificate. Online apps run their Safari extension's content script
// on the provider's own site.
@MainActor
final class WebController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let start: URL
    private let hosts: [String]
    private let login = (Bundle.main.object(forInfoDictionaryKey: "LoginURL") as? String).flatMap(URL.init(string:))
    private var provisional: URL?
    private var redirectTarget: URL?
    private let sessionURL: URL
    private var webView: WKWebView!
    private var cookies: SiteCookies?
    private var cookieTimer: Timer?
    private let failure = UIStackView()
    private let message = UILabel()
    private var failedURL: URL?
    private var started = false
    private var loginView: UIStackView?

    init(start: URL, hosts: [String]) {
        self.start = start
        self.hosts = hosts
        sessionURL = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/LocalVideos/interaction-state")
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        let config = WKWebViewConfiguration()
        config.ignoresViewportScaleLimits = true
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        if !hosts.isEmpty {
            // The sites see Safari, and the extension's script starts at document start in the page world.
            config.applicationNameForUserAgent = "Version/\(ProcessInfo.processInfo.operatingSystemVersion.majorVersion).0 Mobile/15E148 Safari/604.1"
            if Bundle.main.object(forInfoDictionaryKey: "DownloadList") as? Bool == true {
                config.userContentController.addScriptMessageHandler(DownloadList(hosts: hosts), contentWorld: .page, name: DownloadList.name)
            }
            // Video Vault reads the other upload site's pages through hidden web views (SiteWorker.swift);
            // only its own page (not those sites' login pages) may ask.
            if let workers = Bundle.main.object(forInfoDictionaryKey: "SiteWorkers") as? [String: [String: Any]] {
                let workerHosts = Set(workers.values.flatMap { $0["hosts"] as? [String] ?? [] })
                let worker = SiteWorker(workers: workers, pageHosts: hosts.filter { !workerHosts.contains($0) }, store: config.websiteDataStore,
                                        userAgent: config.applicationNameForUserAgent, container: view)
                config.userContentController.addScriptMessageHandler(worker, contentWorld: .page, name: SiteWorker.name)
            }
        }
        webView = WKWebView(frame: .zero, configuration: config)
        if !hosts.isEmpty {
            let durable = (Bundle.main.object(forInfoDictionaryKey: "DurableCookie") as? [String: String]).flatMap { rule in
                rule["name"].flatMap { name in rule["lifetimeFrom"].map { SiteCookies.Durable(name: name, lifetimeFrom: $0) } }
            }
            cookies = SiteCookies(store: webView.configuration.websiteDataStore.httpCookieStore, hosts: hosts,
                                  keep: Bundle.main.object(forInfoDictionaryKey: "KeepCookies") as? [String] ?? [], durable: durable,
                                  backupURL: sessionURL.deletingLastPathComponent().appendingPathComponent("login-cookies.plist"))
            // Sites re-send cookies on responses and cookie notifications are unreliable, so
            // re-check every few seconds while open as well as at resign/background.
            cookieTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.cookies?.keep() }
            }
        }
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        // Safari's pull-down reload; there is no address bar to reload from.
        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self] _ in self?.reload() }, for: .valueChanged)
        webView.scrollView.refreshControl = refresh
        view.backgroundColor = .black
        view.addSubview(webView)
        buildFailureView()
        // Online apps put back their saved login before the first page loads.
        if let cookies { cookies.restore { [weak self] in self?.signIn() } } else { open() }
    }
    // Tango moves an imported Safari login into the web view first; other apps start directly.
    private func signIn() {
        guard Bundle.main.object(forInfoDictionaryKey: "TangoLogin") as? Bool == true else { return begin(scripts: []) }
        TangoSession.prepare(store: webView.configuration.websiteDataStore.httpCookieStore) { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready(let session): hideLogin(); begin(scripts: [session])
            case .pending: showLogin("Confirm that Tango’s Safari website data has been cleared.")
            case .required: showLogin("Tango login is required.")
            }
        }
    }
    // The extension's content script runs at document start in the page world, after any session script.
    private func begin(scripts: [String]) {
        guard !started else { return }
        started = true
        let content = Bundle.main.url(forResource: "content", withExtension: "js").flatMap { try? String(contentsOf: $0, encoding: .utf8) }
        for source in scripts + [content].compactMap({ $0 }) {
            webView.configuration.userContentController.addUserScript(
                WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        }
        open()
    }
    // Returning from Safari after importing re-checks the login.
    func resume() { if loginView != nil { signIn() } }
    // Like a restored Safari tab: reopen the last page with its Back/Forward list.
    private func open() {
        guard let state = try? Data(contentsOf: sessionURL) else { webView.load(URLRequest(url: start)); return }
        webView.interactionState = state
        // An old restore point can reopen a blank page without any navigation callback.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self, !webView.isLoading, !(webView.url.map(allows) ?? false) else { return }
            webView.load(URLRequest(url: start))
        }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        webView.frame = view.bounds
    }

    func saveSession(_ done: @escaping @MainActor () -> Void = {}) {
        if let cookies { cookies.keep(done) } else { done() }
        // Only a page of this app becomes the restore point, never a blank or blocked one.
        guard let url = webView?.url, allows(url), let state = webView?.interactionState as? Data else { return }
        do {
            try FileManager.default.createDirectory(at: sessionURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try state.write(to: sessionURL, options: .atomic)
        } catch { print("WebKit session checkpoint:", error) }
    }

    private func allows(_ url: URL) -> Bool { AppPolicy.allows(url, start: start, hosts: hosts) }

    // Retry the page that failed, otherwise reload in place like Safari (no new Back entry).
    private func reload() {
        failure.isHidden = true
        let failed = failedURL
        failedURL = nil
        if let failed, allows(failed) { webView.load(URLRequest(url: failed)) }
        else if webView.url != nil { webView.reload() }
        else { webView.load(URLRequest(url: start)) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        // The viewer asks for Tango's native login screen when the website says the session is gone.
        if url.scheme == "videoapp", url.host == "login", Bundle.main.object(forInfoDictionaryKey: "TangoLogin") as? Bool == true {
            decisionHandler(.cancel)
            started = false
            webView.configuration.userContentController.removeAllUserScripts()
            showLogin("Tango login is required.")
            return
        }
        // Online sites embed frames (such as a login captcha); only the page itself is confined.
        if !hosts.isEmpty, navigationAction.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        // Other sites (including ads) are blocked, never opened elsewhere.
        guard allows(url) else { decisionHandler(.cancel); return }
        // Porntrex redirects to its ad-heavy home page instead of showing the page: from the videos
        // when signed out (open the login page), from the login page when already signed in (open
        // the videos). The target loads once WebKit has finished cancelling the redirect.
        if let login, url.path == "/", let previous = provisional {
            redirectTarget = previous.path.hasPrefix(start.path) ? login : previous.path == login.path ? start : nil
            if redirectTarget != nil {
                provisional = nil
                decisionHandler(.cancel)
                return
            }
        }
        if navigationAction.targetFrame?.isMainFrame != false { provisional = url }
        decisionHandler(.allow)
    }
    // Links that ask for a new window stay in this tab when they belong to the app.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, allows(url) { webView.load(URLRequest(url: url)) }
        return nil
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        provisional = nil
        failure.isHidden = true
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.scrollView.refreshControl?.endRefreshing()
        // about:blank loads without a policy check (for example from an old restore point).
        guard let url = webView.url, allows(url) else { webView.load(URLRequest(url: start)); return }
        saveSession()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        provisional = nil
        if let target = redirectTarget {
            redirectTarget = nil
            webView.load(URLRequest(url: target))
            return
        }
        webView.scrollView.refreshControl?.endRefreshing()
        let error = error as NSError
        // A cancelled or policy-blocked navigation leaves the current page in place; if nothing of
        // this app is showing (for example a restored page that is no longer allowed), open the start page.
        if error.domain == "WebKitErrorDomain" && error.code == 102 {
            if !(webView.url.map(allows) ?? false) { webView.load(URLRequest(url: start)) }
            return
        }
        if error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled { return }
        failedURL = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL
        message.text = (hosts.isEmpty ? "Can't reach your PC." : "Can't reach \(start.host ?? "the site").") + "\n\(error.localizedDescription)"
        failure.isHidden = false
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView.url == nil { webView.load(URLRequest(url: start)) } else { webView.reload() }
    }

    // Same steps and wording as the original Tango app's login handoff.
    private func showLogin(_ message: String) {
        hideLogin()
        webView.isHidden = true
        let label = UILabel()
        label.numberOfLines = 0
        label.textColor = .lightGray
        label.text = message + "\n\nSign in with Google on Tango in Safari. Enable Tango Login and choose Import login into Tango. Close Tango tabs, then delete only Tango in Safari’s Website Data settings."
        let open = UIButton(type: .system)
        open.setTitle("Open Tango in Safari", for: .normal)
        open.addAction(UIAction { _ in UIApplication.shared.open(URL(string: "https://www.tango.me/")!) }, for: .touchUpInside)
        let confirm = UIButton(type: .system)
        confirm.setTitle("Safari data cleared — continue", for: .normal)
        confirm.addAction(UIAction { [weak self] _ in
            do { try TangoSession.confirm(); self?.signIn() } catch { label.text = error.localizedDescription }
        }, for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [label, open, confirm])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        loginView = stack
    }
    private func hideLogin() {
        loginView?.removeFromSuperview()
        loginView = nil
        webView.isHidden = false
    }

    // Safari shows its own page when a site is unreachable; this is the equivalent.
    private func buildFailureView() {
        message.numberOfLines = 0
        message.textAlignment = .center
        message.textColor = .lightGray
        let retry = UIButton(type: .system)
        retry.setTitle("Retry", for: .normal)
        retry.addAction(UIAction { [weak self] _ in self?.reload() }, for: .touchUpInside)
        failure.axis = .vertical
        failure.spacing = 16
        failure.alignment = .center
        failure.addArrangedSubview(message)
        failure.addArrangedSubview(retry)
        failure.isHidden = true
        failure.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(failure)
        NSLayoutConstraint.activate([
            failure.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failure.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            failure.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
    }
}
