import UIKit
import WebKit

// Video Vault lives on porntrex.com and reads XVideos pages through a hidden web view on
// xvideos.com: the same cookie store and first-party requests, like a second Safari tab.
// The page cannot read them itself (XVideos allows no other origins), and the vault cannot
// live on xvideos.com instead: XVideos' security policy blocks Porntrex media. The page asks
// with webkit.messageHandlers.vaultSite.postMessage({site, path}) and gets {status, url, text}.
// Only the vault page may ask, and only for paths on that site.
@MainActor
final class SiteWorker: NSObject, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    static let name = "vaultSite"
    private struct Site { let page: URL; let hosts: [String]; let view: WKWebView }
    private static let read = """
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 30000);
        const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        return { status: response.status, url: response.url, text: await response.text() };
        """
    private var sites: [String: Site] = [:]
    private var loading: Set<String> = []
    private var loaded: Set<String> = []
    private var waiting: [String: [CheckedContinuation<Void, Error>]] = [:]
    private let pageHosts: [String]

    init(workers: [String: [String: Any]], pageHosts: [String], store: WKWebsiteDataStore, userAgent: String?, container: UIView) {
        self.pageHosts = pageHosts
        super.init()
        for (key, worker) in workers {
            guard let page = (worker["url"] as? String).flatMap(URL.init(string:)), let hosts = worker["hosts"] as? [String] else { continue }
            let config = WKWebViewConfiguration()
            config.websiteDataStore = store
            config.applicationNameForUserAgent = userAgent
            let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: config)
            view.isHidden = true
            view.navigationDelegate = self
            container.insertSubview(view, at: 0)
            sites[key] = Site(page: page, hosts: hosts, view: view)
            load(key)
        }
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "https",
              pageHosts.contains(message.frameInfo.securityOrigin.host),
              let body = message.body as? [String: Any], let key = body["site"] as? String, let site = sites[key],
              let path = body["path"] as? String, let url = AppPolicy.workerURL(path, page: site.page, hosts: site.hosts) else {
            return (nil, "Unsupported site request.")
        }
        do {
            try await ready(key)
            return (try await site.view.callAsyncJavaScript(Self.read, arguments: ["url": url.absoluteString], in: nil, contentWorld: .page), nil)
        } catch {
            return (nil, error.localizedDescription)
        }
    }

    // The worker's page loads at launch, and again after a failure or a crashed web process.
    private func ready(_ key: String) async throws {
        if loaded.contains(key) { return }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            waiting[key, default: []].append(continuation)
            load(key)
        }
    }

    private func load(_ key: String) {
        guard let site = sites[key], !loading.contains(key) else { return }
        loading.insert(key)
        site.view.load(URLRequest(url: site.page))
    }

    private func key(of view: WKWebView) -> String? { sites.first { $0.value.view === view }?.key }

    private func finish(_ view: WKWebView, _ error: Error?) {
        guard let key = key(of: view) else { return }
        loading.remove(key)
        if error == nil { loaded.insert(key) } else { loaded.remove(key) }
        for continuation in waiting.removeValue(forKey: key) ?? [] {
            if let error { continuation.resume(throwing: error) } else { continuation.resume() }
        }
    }

    // A worker stays on its site; it never shows anything.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let site = key(of: webView).flatMap({ sites[$0] }), let url = navigationAction.request.url,
              navigationAction.targetFrame?.isMainFrame == true, AppPolicy.allows(url, start: site.page, hosts: site.hosts) else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(webView, nil) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(webView, error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(webView, error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let key = key(of: webView) else { return }
        loaded.remove(key)
        loading.remove(key)
        load(key)
    }
}
