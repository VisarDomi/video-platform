import UIKit
import WebKit

// A full-screen Safari tab for one provider's videos on the PC. The page, API and
// HLS come from the PC exactly as in Safari; the phone already trusts its certificate.
@MainActor
final class WebController: UIViewController, WKNavigationDelegate {
    private let home: URL
    private let sessionURL: URL
    private var webView: WKWebView!
    private let failure = UIStackView()
    private let message = UILabel()
    private var failedURL: URL?

    init(home: URL) {
        self.home = home
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
        webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true
        webView.navigationDelegate = self
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
        // Like a restored Safari tab: reopen the last page with its Back/Forward list.
        if let state = try? Data(contentsOf: sessionURL) { webView.interactionState = state }
        else { webView.load(URLRequest(url: home)) }
    }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        webView.frame = view.bounds
    }

    func saveSession() {
        guard let state = webView?.interactionState as? Data else { return }
        do {
            try FileManager.default.createDirectory(at: sessionURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try state.write(to: sessionURL, options: .atomic)
        } catch { print("WebKit session checkpoint:", error) }
    }

    // Retry the page that failed, otherwise reload in place like Safari (no new Back entry).
    private func reload() {
        failure.isHidden = true
        let failed = failedURL
        failedURL = nil
        if let failed, LocalPolicy.allows(failed, home: home) { webView.load(URLRequest(url: failed)) }
        else if webView.url != nil { webView.reload() }
        else { webView.load(URLRequest(url: home)) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url.map { LocalPolicy.allows($0, home: home) } == true ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { failure.isHidden = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.scrollView.refreshControl?.endRefreshing()
        saveSession()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
        let error = error as NSError
        // A cancelled or policy-blocked navigation leaves the current page in place.
        if (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled)
            || (error.domain == "WebKitErrorDomain" && error.code == 102) { return }
        failedURL = error.userInfo[NSURLErrorFailingURLErrorKey] as? URL
        message.text = "Can't reach your PC.\n\(error.localizedDescription)"
        failure.isHidden = false
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView.url == nil { webView.load(URLRequest(url: home)) } else { webView.reload() }
    }

    // Safari shows its own page when the PC is unreachable; this is the equivalent.
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
