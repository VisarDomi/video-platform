import AVFoundation
import UIKit
import WebKit

// Builds the player's assets. PC recordings play straight from the PC's HLS (the phone trusts
// its certificate). An online site's media gets the page's Referer, user agent and that site's
// cookies, as the page's own video element would send. Tango's playlists need its stream
// tokens, which live 10 s (TangoTokens), so they come through TangoPlaylists; its segments
// need none and load directly.
@MainActor
final class ViewerMedia {
    private let store: WKHTTPCookieStore
    private let bridge: ViewerBridge
    private let tango: TangoPlaylists?

    init(store: WKHTTPCookieStore, bridge: ViewerBridge, tango: Bool) {
        self.store = store
        self.bridge = bridge
        self.tango = tango ? TangoPlaylists(tokens: TangoTokens(store: store)) : nil
    }

    func start() { tango?.tokens.start() }
    func stop() { tango?.tokens.stop() }

    func asset(_ source: MediaSource, for video: ViewerVideo) async -> AVURLAsset {
        if let tango, video.liveStream { return tango.asset(source.url) }
        if video.local { return AVURLAsset(url: source.url) }
        var headers: [String: String] = [:]
        if let origin = bridge.origin { headers["Referer"] = origin.absoluteString.hasSuffix("/") ? origin.absoluteString : origin.absoluteString + "/" }
        if let agent = bridge.userAgent { headers["User-Agent"] = agent }
        let host = source.url.host ?? ""
        let cookies = await store.allCookies().filter { cookie in
            let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            return host == domain || host.hasSuffix("." + domain)
        }
        return AVURLAsset(url: source.url, options: ["AVURLAssetHTTPHeaderFieldsKey": headers, AVURLAssetHTTPCookiesKey: cookies])
    }
}

// Tango's stream tokens (tt, ttu, tte: 10 s) and session (Tango-ST: 1 h), as packages/auth keeps
// them for the PC: the stream tokens every 5 s while a stream plays. The page keeps its own
// copies fresh while it runs; while the app is in the background its page is suspended, so the
// session is refreshed here when it is about to expire, and the result goes back to the web
// view's cookies before the page uses them again. The refresh token may rotate on a session
// refresh, so this never refreshes the session while the page could be doing it.
actor TangoTokens {
    private static let tokenData = URL(string: "https://gateway.tango.me/proxycador/api/public/v1/live/stream/v1/tokenData")!
    private static let sessionRefresh = URL(string: "https://gateway.tango.me/session-service/public/v2/session/web/refresh")!
    private nonisolated let store: WKHTTPCookieStore
    private let session: URLSession
    private var cookies: [String: HTTPCookie] = [:]
    private var stream: (header: String, expires: Date)?
    private var loop: Task<Void, Never>?
    private var pending: Task<Void, Error>?

    init(store: WKHTTPCookieStore) {
        self.store = store
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        session = URLSession(configuration: configuration)
    }

    nonisolated func start() { Task { await begin() } }
    nonisolated func stop() { Task { await end() } }

    private func begin() {
        guard loop == nil else { return }
        loop = Task {
            while !Task.isCancelled {
                do { try await refresh() } catch { print("Tango stream tokens:", error.localizedDescription) }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func end() {
        loop?.cancel()
        loop = nil
    }

    // A playlist, with fresh stream tokens; a 401 refreshes them once more.
    func playlist(_ url: URL) async throws -> (Data, Int) {
        if stream.map({ $0.expires.timeIntervalSinceNow < 2 }) ?? true { try await refresh() }
        for attempt in 0..<2 {
            var request = URLRequest(url: url, timeoutInterval: 10)
            request.setValue(stream?.header, forHTTPHeaderField: "Cookie")
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 && attempt == 0 { try await refresh(); continue }
            return (data, status)
        }
        throw URLError(.userAuthenticationRequired)
    }

    // One refresh at a time; callers share it.
    private func refresh() async throws {
        if let pending { return try await pending.value }
        let task = Task { try await self.renew() }
        pending = task
        defer { pending = nil }
        try await task.value
    }

    private func renew() async throws {
        await load()
        if await background(), let expiry = cookies["Tango-ST"]?.expiresDate, expiry.timeIntervalSinceNow < 300 {
            try await refreshSession()
        }
        guard let st = cookies["Tango-ST"]?.value else { throw URLError(.userAuthenticationRequired) }
        var request = URLRequest(url: Self.tokenData, timeoutInterval: 10)
        request.setValue("Tango-ST=" + st, forHTTPHeaderField: "Cookie")
        request.setValue("application/json; charset=UTF-8", forHTTPHeaderField: "Accept")
        // As packages/auth does: a request unanswered after 1 s gets a second one; the first answer wins.
        let response = try await hedged(request)
        let fresh = HTTPCookie.cookies(withResponseHeaderFields: response.headerFields, for: Self.tokenData)
        let values = Dictionary(fresh.map { ($0.name, $0.value) }, uniquingKeysWith: { $1 })
        guard response.status == 200, let tt = values["tt"], let ttu = values["ttu"], let tte = values["tte"] else {
            throw URLError(response.status == 401 ? .userAuthenticationRequired : .badServerResponse)
        }
        let expires = Double(tte).map(Date.init(timeIntervalSince1970:)) ?? Date().addingTimeInterval(10)
        stream = ("tt=\(tt);ttu=\(ttu);tte=\(tte)", expires)
    }

    private struct Answer { let status: Int; let headerFields: [String: String] }

    private func hedged(_ request: URLRequest) async throws -> Answer {
        try await withThrowingTaskGroup(of: Answer.self) { group in
            let fetch: @Sendable () async throws -> Answer = { [session] in
                let (_, response) = try await session.data(for: request)
                let http = response as? HTTPURLResponse
                return Answer(status: http?.statusCode ?? 0,
                              headerFields: (http?.allHeaderFields as? [String: String]) ?? [:])
            }
            group.addTask(operation: fetch)
            group.addTask {
                try await Task.sleep(for: .seconds(1))
                return try await fetch()
            }
            defer { group.cancelAll() }
            var failure: Error = URLError(.timedOut)
            for _ in 0..<2 {
                do { if let answer = try await group.next() { return answer } } catch { failure = error }
            }
            throw failure
        }
    }

    // The refresh token names the account and session (as TangoSession.swift reads it).
    private func refreshSession() async throws {
        guard let rt = cookies["Tango-RT"]?.value, let ids = Self.claims(rt) else { throw URLError(.userAuthenticationRequired) }
        var request = URLRequest(url: Self.sessionRefresh, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("Tango-RT=" + rt, forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("https://www.tango.me", forHTTPHeaderField: "Origin")
        request.setValue("https://www.tango.me/", forHTTPHeaderField: "Referer")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["accountId": ids.account, "sessionId": ids.session])
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { throw URLError(.userAuthenticationRequired) }
        let fresh = HTTPCookie.cookies(withResponseHeaderFields: (http.allHeaderFields as? [String: String]) ?? [:], for: Self.sessionRefresh)
            .filter { $0.name == "Tango-ST" || $0.name == "Tango-RT" }
        guard fresh.contains(where: { $0.name == "Tango-ST" }) else { throw URLError(.badServerResponse) }
        for cookie in fresh {
            cookies[cookie.name] = cookie
            await store.setCookie(cookie)
        }
    }

    private static func claims(_ token: String) -> (account: String, session: String)? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let account = claims["accountId"] as? String, let session = claims["sessionId"] as? String else { return nil }
        return (account, session)
    }

    // The web view's Tango cookies: the page refreshes the session there while it runs.
    private func load() async {
        let all = await store.allCookies()
        for cookie in all where cookie.domain.hasSuffix("tango.me") && ["Tango-ST", "Tango-RT"].contains(cookie.name) {
            if let held = cookies[cookie.name], let heldExpiry = held.expiresDate, let expiry = cookie.expiresDate,
               heldExpiry > expiry { continue }
            cookies[cookie.name] = cookie
        }
    }

    private func background() async -> Bool {
        await MainActor.run { UIApplication.shared.applicationState == .background }
    }
}

// Tango's master and media playlists through a resource loader: each request (including a
// live media playlist's reloads) is fetched with the current stream tokens. Playlist addresses
// keep the loader's scheme; segment, key and map addresses become absolute https.
final class TangoPlaylists: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    static let scheme = "tangohls"
    let tokens: TangoTokens
    private let queue = DispatchQueue(label: "VideoApp.TangoPlaylists")

    init(tokens: TangoTokens) { self.tokens = tokens }

    func asset(_ url: URL) -> AVURLAsset {
        let asset = AVURLAsset(url: Self.swap(url, to: Self.scheme))
        asset.resourceLoader.setDelegate(self, queue: queue)
        return asset
    }

    private static func swap(_ url: URL, to scheme: String) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.scheme = scheme
        return components.url!
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        guard let url = loadingRequest.request.url, url.scheme == Self.scheme else { return false }
        let real = Self.swap(url, to: "https")
        let request = UncheckedRequest(value: loadingRequest)
        Task {
            do {
                let (data, status) = try await tokens.playlist(real)
                guard status == 200 else {
                    request.value.finishLoading(with: NSError(domain: NSURLErrorDomain, code: status == 404 || status == 410
                        ? NSURLErrorFileDoesNotExist : NSURLErrorBadServerResponse, userInfo: ["status": status]))
                    return
                }
                let text = Self.rewrite(String(decoding: data, as: UTF8.self), base: real)
                request.value.dataRequest?.respond(with: Data(text.utf8))
                request.value.finishLoading()
            } catch {
                request.value.finishLoading(with: error)
            }
        }
        return true
    }

    private struct UncheckedRequest: @unchecked Sendable { let value: AVAssetResourceLoadingRequest }

    static func rewrite(_ text: String, base: URL) -> String {
        var playlistNext = false
        return text.components(separatedBy: "\n").map { raw -> String in
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { return raw }
            if line.hasPrefix("#") {
                if line.hasPrefix("#EXT-X-STREAM-INF") { playlistNext = true }
                let playlistTag = line.hasPrefix("#EXT-X-MEDIA") || line.hasPrefix("#EXT-X-I-FRAME-STREAM-INF")
                return replacingURIAttribute(line) { uri in address(uri, base: base, playlist: playlistTag) }
            }
            defer { playlistNext = false }
            return address(line, base: base, playlist: playlistNext || line.lowercased().contains(".m3u8"))
        }.joined(separator: "\n")
    }

    private static func address(_ uri: String, base: URL, playlist: Bool) -> String {
        guard let url = URL(string: uri, relativeTo: base)?.absoluteURL else { return uri }
        return playlist ? swap(url, to: scheme).absoluteString : url.absoluteString
    }

    private static func replacingURIAttribute(_ line: String, _ transform: (String) -> String) -> String {
        guard let start = line.range(of: "URI=\"") else { return line }
        guard let end = line[start.upperBound...].firstIndex(of: "\"") else { return line }
        return line.replacingCharacters(in: start.upperBound..<end, with: transform(String(line[start.upperBound..<end])))
    }
}
