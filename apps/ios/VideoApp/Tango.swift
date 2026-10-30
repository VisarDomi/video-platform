import Foundation
import KitNet
import KitCore

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
    case verificationRequired
    case failed(String)
    var errorDescription: String? {
        switch self {
        case .loginRequired: "Tango login is required."
        case .verificationRequired: "Tango needs browser verification to renew this login. Your saved login has been kept."
        case .failed(let text): text
        }
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

    static func isChallenge(status: Int, data: Data) -> Bool {
        status == 424 && (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["errorCode"] as? String == "CHALLENGE_REQUIRED"
    }

    static func firstParty(_ cookie: HTTPCookie) -> Bool {
        let domain = cookie.domain.lowercased()
        return domain == "tango.me" || domain.hasSuffix(".tango.me")
    }

    private static func tokenDate(_ value: String, key: String) -> Date? {
        let parts = value.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var text = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        text += String(repeating: "=", count: (4 - text.count % 4) % 4)
        guard let bytes = Data(base64Encoded: text), let body = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let seconds = body[key] as? Double else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }

    static func expiration(_ cookie: HTTPCookie) -> Date {
        min(cookie.expiresDate ?? .distantFuture, tokenDate(cookie.value, key: "exp") ?? .distantFuture)
    }

    static func credential(_ name: String, in jar: CookieJar) -> HTTPCookie? {
        // The current website issues credentials through /api on www.tango.me. Older
        // installations used gateway.tango.me and a different cookie path.
        jar.all.filter { $0.name == name && firstParty($0) && expiration($0) > Date() }.max {
            (tokenDate($0.value, key: "iat") ?? $0.expiresDate ?? .distantPast) < (tokenDate($1.value, key: "iat") ?? $1.expiresDate ?? .distantPast)
        }
    }

    // Keep every previously used first-party cookie scope on the same credential, in
    // one durable snapshot. Removing first would briefly persist an empty login.
    static func storeLogin(_ cookies: [HTTPCookie], in jar: CookieJar) {
        let trusted = cookies.filter(firstParty)
        var batch = trusted
        for old in jar.all where firstParty(old) && ["Tango-ST", "Tango-RT"].contains(old.name) {
            guard !trusted.contains(where: { $0.name == old.name && $0.domain == old.domain && $0.path == old.path }),
                  let fresh = trusted.first(where: { $0.name == old.name }), var properties = fresh.properties else { continue }
            properties[.domain] = old.domain
            properties[.path] = old.path
            if let replacement = HTTPCookie(properties: properties) { batch.append(replacement) }
        }
        jar.set(batch)
        jar.flush()
    }

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
    typealias LoginRecovery = @Sendable () async throws -> [HTTPCookie]
    let jar: CookieJar
    private let session: URLSession
    private var refreshing: Task<Void, Error>?
    private var stream: (header: String, expires: Date)?
    private var streamTask: Task<Void, Error>?
    private var loop: Task<Void, Never>?
    private let diagnostics: BackgroundWriter?
    private var events: [NetworkEvent] = []
    private let loginRecovery: LoginRecovery?
    private var proactiveRefresh: Task<Void, Never>?
    private var nextRefreshAttempt = Date.distantPast
    private var lastRefreshFailure: Error?

    private struct NetworkEvent: Codable, Sendable {
        var time = Date()
        var kind: String
        var path: String
        var status: Int?
        var contentType: String?
        var requestCookieNames: [String]
        var responseCookieNames: [String] = []
        var legacyHeaderCast: Bool?
        var errorDomain: String?
        var errorCode: Int?
        var serverError: String?
    }

    private struct NetworkSnapshot: Codable, Sendable {
        var build: String
        var source: String
        var events: [NetworkEvent]
    }

    init(jar: CookieJar, diagnosticURL: URL? = nil, configuration supplied: URLSessionConfiguration? = nil, loginRecovery: LoginRecovery? = nil) {
        self.jar = jar
        self.loginRecovery = loginRecovery
        diagnostics = diagnosticURL.map { BackgroundWriter(url: $0, label: "tango-network") }
        let configuration = supplied ?? URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
    }

    // Bounded, credential-free diagnostics. Only cookie names, HTTP status and transport
    // error codes are stored; headers, bodies, token values and account IDs never are.
    private func fetch(_ request: URLRequest, kind: String) async throws -> (Data, URLResponse) {
        let names = (request.value(forHTTPHeaderField: "Cookie") ?? "").split(separator: ";").map { $0.split(separator: "=", maxSplits: 1).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? "" }
        var event = NetworkEvent(kind: kind, path: request.url?.path ?? "", requestCookieNames: names)
        do {
            let answer = try await session.data(for: request)
            if let http = answer.1 as? HTTPURLResponse {
                event.status = http.statusCode
                event.contentType = http.value(forHTTPHeaderField: "Content-Type")
                event.legacyHeaderCast = http.allHeaderFields is [String: String]
                if http.statusCode >= 400, let body = try? JSONSerialization.jsonObject(with: answer.0) as? [String: Any] {
                    let text = ["code", "errorCode", "status", "error", "message", "errorMessage", "error_description", "reason"].compactMap { key -> String? in
                        guard let value = body[key] as? String else { return nil }
                        return key + ": " + value
                    }.joined(separator: "; ")
                    event.serverError = "fields=" + body.keys.sorted().joined(separator: ",") + "; " + String(text.replacingOccurrences(of: #"eyJ[A-Za-z0-9_.-]{20,}"#, with: "<redacted-token>", options: .regularExpression)
                        .replacingOccurrences(of: #"Tango-(?:ST|RT)=[^;\s]+"#, with: "<redacted-cookie>", options: .regularExpression).prefix(500))
                }
                event.responseCookieNames = http.allHeaderFields.flatMap { key, value -> [String] in
                    guard String(describing: key).lowercased() == "set-cookie" else { return [] }
                    let values = (value as? [String]) ?? (value as? String).map { [$0] } ?? []
                    return values.flatMap { HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": $0], for: http.url ?? request.url!).map(\.name) }
                }
            }
            record(event)
            return answer
        } catch {
            let error = error as NSError
            event.errorDomain = error.domain
            event.errorCode = error.code
            record(event)
            throw error
        }
    }

    private func record(_ event: NetworkEvent) {
        guard let diagnostics else { return }
        events.append(event)
        if events.count > 24 { events.removeFirst(events.count - 24) }
        diagnostics.save(json: NetworkSnapshot(build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
                                               source: Bundle.main.object(forInfoDictionaryKey: "VideoSourceRevision") as? String ?? "", events: events))
    }

    nonisolated var refreshToken: String? { Tango.credential("Tango-RT", in: jar)?.value }
    nonisolated var signedIn: Bool { refreshToken.flatMap(Tango.claims) != nil }

    private nonisolated func cookie(_ name: String) -> HTTPCookie? {
        Tango.credential(name, in: jar)
    }

    // Renew ahead of expiry, keeping usable access/stream tokens flowing while the
    // provider's browser verification completes. Only expired/rejected tokens wait.
    func sessionToken() async throws -> String {
        if let st = cookie("Tango-ST"), Tango.expiration(st).timeIntervalSinceNow > 0 {
            if Tango.expiration(st).timeIntervalSinceNow <= 300, proactiveRefresh == nil, Date() >= nextRefreshAttempt {
                proactiveRefresh = Task {
                    defer { self.proactiveRefresh = nil }
                    do { try await self.refresh() } catch { /* The expired-token path reports it. */ }
                }
            }
            return st.value
        }
        try await refresh()
        guard let st = cookie("Tango-ST") else { throw TangoError.loginRequired }
        return st.value
    }

    // One refresh at a time; callers share it. A 401/403 means the login is gone.
    func refresh() async throws {
        if let refreshing { return try await refreshing.value }
        if Date() < nextRefreshAttempt, let lastRefreshFailure { throw lastRefreshFailure }
        let task = Task { try await self.renewSession() }
        refreshing = task
        defer { refreshing = nil }
        do {
            try await task.value
            lastRefreshFailure = nil
            nextRefreshAttempt = .distantPast
        } catch {
            lastRefreshFailure = error
            if case TangoError.verificationRequired = error {
                nextRefreshAttempt = Date().addingTimeInterval(120)
            } else { nextRefreshAttempt = Date().addingTimeInterval(30) }
            throw error
        }
    }

    func retryAfterConnectionChange() {
        // Never cancel an in-flight rotating-token request; allow one new attempt after
        // a real reconnection/foreground/manual retry once that owner has finished.
        guard refreshing == nil else { return }
        nextRefreshAttempt = .distantPast
        lastRefreshFailure = nil
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
        let (data, response) = try await fetch(request, kind: "session-refresh")
        guard refreshToken == rt else { return } // A newer explicit login owns the jar now.
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if http.statusCode == 401 || http.statusCode == 403 { throw TangoError.loginRequired }
        if Tango.isChallenge(status: http.statusCode, data: data) {
            guard let loginRecovery else { throw TangoError.verificationRequired }
            do {
                let cookies = try await loginRecovery()
                guard refreshToken == rt else { return }
                let trusted = cookies.filter(Tango.firstParty)
                guard let replacement = trusted.first(where: { $0.name == "Tango-RT" }),
                      Tango.claims(replacement.value)?.account == ids.account,
                      trusted.contains(where: { $0.name == "Tango-ST" && ($0.expiresDate ?? .distantFuture) > Date() })
                else { throw TangoError.verificationRequired }
                commit(trusted)
                record(NetworkEvent(kind: "browser-recovery", path: "/api/tango/phone-session", status: 200, requestCookieNames: [], responseCookieNames: trusted.map(\.name)))
                return
            } catch { throw TangoError.verificationRequired }
        }
        guard http.statusCode == 200 else { throw TangoError.failed("Tango session refresh answered \(http.statusCode)") }
        let fresh = HTTPCookie.cookies(withResponseHeaderFields: (http.allHeaderFields as? [String: String]) ?? [:], for: Tango.refreshURL)
            .filter { $0.name == "Tango-ST" || $0.name == "Tango-RT" }
        guard fresh.contains(where: { $0.name == "Tango-ST" }) else { throw TangoError.failed("Tango did not return a session token") }
        // A rotated refresh token is saved (and synced) before anything else.
        commit(fresh)
    }

    private func commit(_ cookies: [HTTPCookie]) {
        Tango.storeLogin(cookies.filter { ["Tango-ST", "Tango-RT"].contains($0.name) }, in: jar)
    }

    // Gateway requests with the session's cookies; a 401/403 refreshes once more.
    func send(_ path: String, method: String = "GET", body: Data? = nil, json: Bool = false) async throws -> Data {
        for attempt in 0..<2 {
            let request = Tango.request(path, method: method, body: body, json: json, sessionToken: try await sessionToken())
            let (data, response) = try await fetch(request, kind: "gateway")
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if Tango.isChallenge(status: status, data: data) {
                if attempt == 0 { try await refresh(); continue }
                throw TangoError.verificationRequired
            }
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
        for attempt in 0..<2 {
            let st = try await sessionToken()
            var request = URLRequest(url: Tango.tokenURL, timeoutInterval: 10)
            request.setValue("Tango-ST=" + st, forHTTPHeaderField: "Cookie")
            request.setValue("application/json; charset=UTF-8", forHTTPHeaderField: "Accept")
            // A slow request is hedged; a rejected token is renewed only once.
            let answer = try await hedged(request)
            if answer.status == 401 || Tango.isChallenge(status: answer.status, data: answer.body) {
                if attempt == 0 { try await refresh(); continue }
                throw (answer.status == 401 ? TangoError.loginRequired : TangoError.verificationRequired)
            }
            let values = Dictionary(HTTPCookie.cookies(withResponseHeaderFields: answer.headers, for: Tango.tokenURL).map { ($0.name, $0.value) }, uniquingKeysWith: { $1 })
            guard answer.status == 200, let tt = values["tt"], let ttu = values["ttu"], let tte = values["tte"] else { throw URLError(.badServerResponse) }
            stream = ("tt=\(tt);ttu=\(ttu);tte=\(tte)", Double(tte).map(Date.init(timeIntervalSince1970:)) ?? Date().addingTimeInterval(10))
            return
        }
        throw TangoError.verificationRequired
    }

    private struct Answer: Sendable { let status: Int; let headers: [String: String]; let body: Data }

    private func hedged(_ request: URLRequest) async throws -> Answer {
        try await withThrowingTaskGroup(of: Answer.self) { group in
            let fetch: @Sendable () async throws -> Answer = { [session] in
                let (data, response) = try await session.data(for: request)
                let http = response as? HTTPURLResponse
                return Answer(status: http?.statusCode ?? 0, headers: (http?.allHeaderFields as? [String: String]) ?? [:], body: data)
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
