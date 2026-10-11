#if canImport(UIKit)
import UIKit
import WebKit
import KitCore

// The one place a native app still opens WebKit: once, to carry data the web version kept in
// WebKit's storage (localStorage, IndexedDB, cookies) into the app's own files. A hidden web
// view loads a page at the old origin (the PC's website, or a custom scheme served by
// `pages`), runs `script` (an async JavaScript function body whose return value must be
// JSON), and hands back the result. Callers mark the migration done in their own files, so
// it never runs twice; when it fails (the PC is off) it runs again at the next launch.
@MainActor
public final class WebStorageReader: NSObject, WKNavigationDelegate {
    private var webView: WKWebView?
    private var continuation: CheckedContinuation<Void, Error>?

    // Serves an empty page for every request of a custom scheme (the origin is what matters).
    final class EmptyPages: NSObject, WKURLSchemeHandler {
        func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
            guard let url = task.request.url else { return }
            let data = Data("<!doctype html><title>migration</title>".utf8)
            task.didReceive(URLResponse(url: url, mimeType: "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
            task.didReceive(data)
            task.didFinish()
        }
        func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
    }

    // `customScheme`: the scheme to serve empty pages for (e.g. "gallery" for gallery://app/).
    public func read(_ url: URL, customScheme: String? = nil, script: String, timeout: TimeInterval = 20) async throws -> Any? {
        let configuration = WKWebViewConfiguration()
        if let customScheme { configuration.setURLSchemeHandler(EmptyPages(), forURLScheme: customScheme) }
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
        webView.navigationDelegate = self
        self.webView = webView
        defer { self.webView = nil }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.continuation = continuation
            webView.load(URLRequest(url: url))
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in self?.finish(URLError(.timedOut)) }
        }
        let result = try await webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page)
        return result
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(nil) }
    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(error) }
    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(error) }

    private func finish(_ error: Error?) {
        guard let continuation else { return }
        self.continuation = nil
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    }
}
#endif
