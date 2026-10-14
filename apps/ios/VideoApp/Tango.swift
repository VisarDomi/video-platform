import Foundation
import KitNet

// Tango live (packages/app providers/tango-live.ts, ported): followed streams first, then
// recommendations, one entry per streamer, never blocked ones; Follow, two-step Block and
// co-streamers. The gateway cookies live in the app's jar (CookieJar) and TangoSession is their
// only owner: one session refresh at a time, and a rotated refresh token is saved before
// anything else uses the new session (packages/auth decisions.md).

struct TangoStream: Codable, Sendable, Equatable {
    var streamerId: String
    var streamId: String
    var masterListUrl: String
    var firstName: String
    var alias: String?
    var following: Bool
    var parent: String?

    var title: String { "\((alias?.isEmpty == false ? alias! : streamerId)) \(firstName)".trimmingCharacters(in: .whitespaces) }
}

enum TangoError: LocalizedError {
    case loginRequired
    case failed(String)
    var errorDescription: String? {
        switch self { case .loginRequired: "Tango login is required."; case .failed(let text): text }
    }
}

enum Tango {
    static let gateway = URL(string: "https://gateway.tango.me")!

    // A gateway request with the session. A body that is not JSON (an account or stream ID) is
    // labelled as text, as a browser sends a string: unlabelled, URLSession calls it a form, and
    // follow/add and follow/remove answer 500 to that (October 14, 2026: Follow did nothing).
    static func request(_ path: String, method: String, body: Data?, json: Bool, sessionToken: String) -> URLRequest {
        var request = URLRequest(url: URL(string: path, relativeTo: gateway)!.absoluteURL, timeoutInterval: 20)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("Tango-ST=" + sessionToken, forHTTPHeaderField: "Cookie")
        request.setValue("application/json; charset=UTF-8", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue(json ? "application/json" : "text/plain;charset=UTF-8", forHTTPHeaderField: "Content-Type") }
        return request
    }
    static let publicAPI = "https://gateway.tango.me/proxycador/api/public/v1"
    static let refreshURL = URL(string: "https://gateway.tango.me/session-service/public/v2/session/web/refresh")!
    static let tokenURL = URL(string: "https://gateway.tango.me/proxycador/api/public/v1/live/stream/v1/tokenData")!

    // The account and session a refresh names, from the refresh token's payload.
    static func claims(_ token: String) -> (account: String, session: String)? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let account = object["accountId"] as? String, let session = object["sessionId"] as? String, !account.isEmpty, !session.isEmpty else { return nil }
        return (account, session)
    }

    // A recommendation record as a stream: live, public, with a playlist.
    static func stream(_ record: [String: Any], following: Bool) -> TangoStream? {
        let anchor = record["anchor"] as? [String: Any], stream = record["stream"] as? [String: Any]
        guard let streamerId = anchor?["encryptedAccountId"] as? String ?? stream?["encryptedAccountId"] as? String,
              let streamId = stream?["id"] as? String ?? (stream?["id"] as? NSNumber)?.stringValue,
              let master = stream?["masterListUrl"] as? String, stream?["status"] as? String == "LIVING",
              record["isPublic"] as? Bool == true || stream?["streamKind"] as? String == "PUBLIC" else { return nil }
        let alias = ((anchor?["aliases"] as? [[String: Any]])?.first?["alias"]) as? String
        return TangoStream(streamerId: streamerId, streamId: streamId, masterListUrl: master, firstName: anchor?["firstName"] as? String ?? streamerId,
                           alias: alias, following: following, parent: nil)
    }

    static func records(_ data: Data, following: Bool) throws -> [TangoStream] {
        guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any], let records = body["records"] as? [[String: Any]] else {
            throw TangoError.failed("Tango recommendation records are not an array")
        }
        return records.compactMap { stream($0, following: following) }
    }

    // The blocklist answers as an array or as {users}.
    static func blocklist(_ data: Data) throws -> Set<String> {
        let body = try JSONSerialization.jsonObject(with: data)
        if let list = body as? [String] { return Set(list) }
        guard let users = (body as? [String: Any])?["users"] as? [String] else { throw TangoError.failed("Tango blocklist is not a list") }
        return Set(users)
    }

    // Followed first, then recommendations; one entry per streamer (followed wins); not blocked.
    static func merge(followed: [TangoStream], recommended: [TangoStream], blocked: Set<String>) -> [TangoStream] {
        var order: [String] = [], byID: [String: TangoStream] = [:]
        for stream in followed + recommended where !blocked.contains(stream.streamerId) {
            if byID[stream.streamerId] == nil { order.append(stream.streamerId); byID[stream.streamerId] = stream }
            else if stream.following { byID[stream.streamerId] = stream }
        }
        return order.compactMap { byID[$0] }
    }

    static func named(_ streams: [TangoStream], profiles data: Data) -> [TangoStream] {
        guard let profiles = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return streams }
        return streams.map { stream in
            var stream = stream
            let profile = (profiles[stream.streamerId] as? [String: Any])?["basicProfile"] as? [String: Any]
            if let alias = ((profile?["aliases"] as? [[String: Any]])?.first?["alias"]) as? String { stream.alias = alias }
            if let first = profile?["firstName"] as? String { stream.firstName = first }
            return stream
        }
    }

    // A stream's co-streamers (not the streamer itself, not blocked).
    static func coStreamers(_ data: Data, of streamer: String, blocked: Set<String>) throws -> [TangoStream] {
        guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw TangoError.failed("Tango watch response is not an object") }
        guard let multi = body["multiBroadcast"], !(multi is NSNull) else { return [] }
        guard let items = (multi as? [String: Any])?["streams"] as? [[String: Any]] else { throw TangoError.failed("Tango multi-broadcast streams are not an array") }
        return items.compactMap { item in
            let stream = item["stream"] as? [String: Any], descriptor = stream?["mbDescriptor"] as? [String: Any]
            guard let account = descriptor?["accountId"] as? String, let streamId = descriptor?["streamId"] as? String ?? (descriptor?["streamId"] as? NSNumber)?.stringValue,
                  let url = stream?["streamURL"] as? String, account != streamer, !blocked.contains(account) else { return nil }
            return TangoStream(streamerId: account, streamId: streamId, masterListUrl: url, firstName: account, alias: nil, following: false, parent: streamer)
        }
    }
}

// The session (Tango-ST, an hour; refreshed from Tango-RT) and the playback tokens (tt, ttu,
// tte: 10 seconds), for the list's requests and the player's playlists.
actor TangoSession {
    let jar: CookieJar
    private let session: URLSession
    private var refreshing: Task<Void, Error>?
    private var stream: (header: String, expires: Date)?
    private var streamTask: Task<Void, Error>?
    private var loop: Task<Void, Never>?

    init(jar: CookieJar) {
        self.jar = jar
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
    }

    nonisolated var refreshToken: String? { jar.value("Tango-RT", for: Tango.refreshURL) }
    nonisolated var signedIn: Bool { refreshToken.flatMap(Tango.claims) != nil }

    private nonisolated func cookie(_ name: String) -> HTTPCookie? {
        jar.cookies(for: Tango.tokenURL).first { $0.name == name } ?? jar.cookies(for: Tango.refreshURL).first { $0.name == name }
    }

    // A session token good for a while (refreshed when it has under five minutes left).
    func sessionToken() async throws -> String {
        if let st = cookie("Tango-ST"), (st.expiresDate ?? .distantFuture).timeIntervalSinceNow > 300 { return st.value }
        try await refresh()
        guard let st = cookie("Tango-ST") else { throw TangoError.loginRequired }
        return st.value
    }

    // One refresh at a time; callers share it. A 401/403 means the login is gone.
    func refresh() async throws {
        if let refreshing { return try await refreshing.value }
        let task = Task { try await self.renewSession() }
        refreshing = task
        defer { refreshing = nil }
        try await task.value
    }

    private func renewSession() async throws {
        guard let rt = refreshToken, let ids = Tango.claims(rt) else { throw TangoError.loginRequired }
        var request = URLRequest(url: Tango.refreshURL, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("Tango-RT=" + rt, forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("https://www.tango.me", forHTTPHeaderField: "Origin")
        request.setValue("https://www.tango.me/", forHTTPHeaderField: "Referer")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["accountId": ids.account, "sessionId": ids.session])
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 401 || http.statusCode == 403 { throw TangoError.loginRequired }
        guard http.statusCode == 200 else { throw TangoError.failed("Tango session refresh answered \(http.statusCode)") }
        let fresh = HTTPCookie.cookies(withResponseHeaderFields: (http.allHeaderFields as? [String: String]) ?? [:], for: Tango.refreshURL)
            .filter { $0.name == "Tango-ST" || $0.name == "Tango-RT" }
        guard fresh.contains(where: { $0.name == "Tango-ST" }) else { throw TangoError.failed("Tango did not return a session token") }
        // A rotated refresh token is saved (and synced) before anything else.
        jar.set(fresh)
        jar.flush()
    }

    // Gateway requests with the session's cookies; a 401/403 refreshes once more.
    func send(_ path: String, method: String = "GET", body: Data? = nil, json: Bool = false) async throws -> Data {
        for attempt in 0..<2 {
            let request = Tango.request(path, method: method, body: body, json: json, sessionToken: try await sessionToken())
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if (status == 401 || status == 403) && attempt == 0 { try await refresh(); continue }
            if status == 401 || status == 403 { throw TangoError.loginRequired }
            guard (200...299).contains(status) else { throw TangoError.failed("\(request.url!.path) answered \(status)") }
            return data
        }
        throw TangoError.loginRequired
    }

    // MARK: playback tokens

    nonisolated func start() { Task { await begin() } }
    nonisolated func stop() { Task { await end() } }

    private func begin() {
        guard loop == nil else { return }
        loop = Task {
            while !Task.isCancelled {
                do { try await refreshStream() } catch { print("Tango stream tokens:", error.localizedDescription) }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func end() {
        loop?.cancel()
        loop = nil
    }

    // A playlist with fresh stream tokens; a 401 renews them once more.
    func playlist(_ url: URL) async throws -> (Data, Int) {
        if stream.map({ $0.expires.timeIntervalSinceNow < 2 }) ?? true { try await refreshStream() }
        for attempt in 0..<2 {
            var request = URLRequest(url: url, timeoutInterval: 10)
            request.setValue(stream?.header, forHTTPHeaderField: "Cookie")
            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 && attempt == 0 { try await refreshStream(); continue }
            return (data, status)
        }
        throw URLError(.userAuthenticationRequired)
    }

    private func refreshStream() async throws {
        if let streamTask { return try await streamTask.value }
        let task = Task { try await self.renewStream() }
        streamTask = task
        defer { streamTask = nil }
        try await task.value
    }

    private func renewStream() async throws {
        let st = try await sessionToken()
        var request = URLRequest(url: Tango.tokenURL, timeoutInterval: 10)
        request.setValue("Tango-ST=" + st, forHTTPHeaderField: "Cookie")
        request.setValue("application/json; charset=UTF-8", forHTTPHeaderField: "Accept")
        // As packages/auth does: a request unanswered after 1 s gets a second one; the first answer wins.
        let answer = try await hedged(request)
        if answer.status == 401 { try await refresh(); throw URLError(.userAuthenticationRequired) }
        let values = Dictionary(HTTPCookie.cookies(withResponseHeaderFields: answer.headers, for: Tango.tokenURL).map { ($0.name, $0.value) }, uniquingKeysWith: { $1 })
        guard answer.status == 200, let tt = values["tt"], let ttu = values["ttu"], let tte = values["tte"] else { throw URLError(.badServerResponse) }
        stream = ("tt=\(tt);ttu=\(ttu);tte=\(tte)", Double(tte).map(Date.init(timeIntervalSince1970:)) ?? Date().addingTimeInterval(10))
    }

    private struct Answer: Sendable { let status: Int; let headers: [String: String] }

    private func hedged(_ request: URLRequest) async throws -> Answer {
        try await withThrowingTaskGroup(of: Answer.self) { group in
            let fetch: @Sendable () async throws -> Answer = { [session] in
                let (_, response) = try await session.data(for: request)
                let http = response as? HTTPURLResponse
                return Answer(status: http?.statusCode ?? 0, headers: (http?.allHeaderFields as? [String: String]) ?? [:])
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

    // MARK: the list and the streamer actions

    func live() async throws -> [TangoStream] {
        async let blocked = send("/abregistrar/connection/v1/blocklist")
        async let followed = send("/recommendator/social/v2/list/following?includeAlias=true", method: "POST", body: Data("{}".utf8), json: true)
        async let recommended = send("/recommendator/social/v2/list/following_recommendations", method: "POST", body: Data("{}".utf8), json: true)
        let streams = Tango.merge(followed: try Tango.records(try await followed, following: true),
                                  recommended: try Tango.records(try await recommended, following: false),
                                  blocked: try Tango.blocklist(try await blocked))
        return await named(streams)
    }

    // Names are best effort: a failed lookup keeps the IDs.
    func named(_ streams: [TangoStream]) async -> [TangoStream] {
        guard !streams.isEmpty, let body = try? JSONSerialization.data(withJSONObject: streams.map(\.streamerId)),
              let data = try? await send(Tango.publicAPI + "/profiles/v2/batch?basicProfile=true&liveStats=false&followStats=false", method: "POST", body: body, json: true)
        else { return streams }
        return Tango.named(streams, profiles: data)
    }

    func follow(_ streamer: String, _ follow: Bool) async throws {
        _ = try await send(Tango.publicAPI + "/follow/\(follow ? "add" : "remove")", method: "POST", body: Data(streamer.utf8))
    }

    // Two steps, as on the website: unfollow first, then block.
    func block(_ streamer: String, following: Bool) async throws {
        if following { try await self.follow(streamer, false) }
        let data = try await send("/abregistrar/connection/v1/blocklist", method: "POST",
                                  body: try JSONSerialization.data(withJSONObject: ["action": "BLOCK", "account_id": [streamer]]), json: true)
        let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard (result?["error_code"] as? NSNumber)?.intValue == 0 else { throw TangoError.failed(result?["error_message"] as? String ?? "Tango did not block this streamer.") }
    }

    func related(streamer: String, streamId: String) async throws -> [TangoStream] {
        async let watch = send(Tango.publicAPI + "/live/stream/v2/watch?requestId=\(UUID().uuidString.lowercased())", method: "POST", body: Data(streamId.utf8))
        async let blocked = send("/abregistrar/connection/v1/blocklist")
        return await named(try Tango.coStreamers(try await watch, of: streamer, blocked: try Tango.blocklist(try await blocked)))
    }
}
