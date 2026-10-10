import Foundation
import WebKit

// The list page and the native viewer (packages/app routes/nativeViewer.ts). The page posts
// `ready`, `list` (whenever its list changes) and `open` (a row, or a viewer address it was
// opened at); the viewer calls `window.__videoApp.call(name, args)` for what only the provider
// can do, answered as {ok} or {error, auth}. Only the app's own pages may post.
@MainActor
final class ViewerBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "videoViewer"

    struct Open { let provider: String; let videos: [ViewerVideo]; let index: Int; let progress: [String: Any] }

    enum Failure: LocalizedError {
        case authentication(String), page(String)
        var errorDescription: String? {
            switch self { case .authentication(let message), .page(let message): message }
        }
    }

    weak var webView: WKWebView?
    var onOpen: ((Open) -> Void)?
    var onList: (([ViewerVideo]) -> Void)?
    // The page's origin (Referer for its media) and user agent, from its `ready`.
    private(set) var origin: URL?
    private(set) var userAgent: String?
    private var ready = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private let allows: (URL) -> Bool

    init(allows: @escaping (URL) -> Bool) { self.allows = allows }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url ?? message.webView?.url, allows(page),
              let body = message.body as? [String: Any], let type = body["type"] as? String,
              let provider = body["provider"] as? String else { return (nil, "Unsupported viewer message.") }
        switch type {
        case "ready":
            origin = (body["origin"] as? String).flatMap(URL.init(string:))
            userAgent = body["userAgent"] as? String
            ready = true
            for continuation in waiting { continuation.resume() }
            waiting = []
        case "list":
            onList?((body["videos"] as? [Any] ?? []).compactMap(ViewerVideo.init))
        case "open":
            let videos = (body["videos"] as? [Any] ?? []).compactMap(ViewerVideo.init)
            guard !videos.isEmpty else { break }
            let index = min(max((body["index"] as? Int) ?? 0, 0), videos.count - 1)
            onOpen?(Open(provider: provider, videos: videos, index: index, progress: body["progress"] as? [String: Any] ?? [:]))
        default:
            return (nil, "Unsupported viewer message.")
        }
        return (nil, nil)
    }

    // A new document (navigation or a restarted web process) answers again once it says it is ready.
    func pageChanged() { ready = false }

    // Waits for the page while it loads or is suspended in the background.
    func call(_ name: String, _ args: [Any] = []) async throws -> Any? {
        while !ready { await withCheckedContinuation { waiting.append($0) } }
        guard let webView else { throw Failure.page("The page is gone.") }
        let result = try await webView.callAsyncJavaScript("return await window.__videoApp.call(name, args)",
                                                           arguments: ["name": name, "args": args], in: nil, contentWorld: .page)
        guard let answer = result as? [String: Any] else { throw Failure.page("The page did not answer \(name).") }
        if let error = answer["error"] as? String {
            throw (answer["auth"] as? Bool) == true ? Failure.authentication(error) : Failure.page(error)
        }
        return answer["ok"] is NSNull ? nil : answer["ok"]
    }

    // Fire and forget: list changes, the highlighted row.
    func send(_ name: String, _ args: [Any] = []) {
        Task { do { _ = try await call(name, args) } catch { print("Viewer \(name):", error.localizedDescription) } }
    }

    func resolve(_ video: ViewerVideo) async throws -> MediaSource {
        guard let source = MediaSource(try await call("resolve", [video.raw])) else { throw Failure.page("No playable source.") }
        return source
    }
}
