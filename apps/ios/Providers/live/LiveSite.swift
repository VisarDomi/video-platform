import Foundation
import KitCore
import KitNet

// A live site that needs an account, as the simulator's site A serves it (packages/simulator,
// "ts-live"; on the PC its plug-in, plugins/ts-live): the followed accounts that are live now,
// their names, follow, and short-lived stream tokens for the playlists.
//
// The phone holds a token family of its own in the app's cookie jar (CookieJar): a rotating
// refresh token, the device cookie and the session token (an hour) they yield. The session is
// their only owner: one refresh at a time, and the rotated refresh token is in the jar before
// anything else uses the new session (a spent refresh token is gone for good). The first family
// comes from the PC (LivePCLogin), which signs in with its own account and never shares its own
// tokens.

struct LiveStream: Codable, Sendable, Equatable {
    var accountId: String
    var streamId: String
    var masterUrl: String
    var name: String
    var alias: String?
    var following: Bool

    // The alias first, as the site shows a streamer, then the first name unless it is the same;
    // the account ID when it has neither.
    var title: String {
        var parts: [String] = []
        for part in [alias, name] { if let part, !part.isEmpty, !parts.contains(part) { parts.append(part) } }
        return parts.isEmpty ? accountId : parts.joined(separator: " ")
    }
}

enum LiveError: LocalizedError, Equatable {
    case loginRequired
    case failed(String)
    var errorDescription: String? {
        switch self {
        case .loginRequired: "The site's login is required."
        case .failed(let text): text
        }
    }
}

// The site's tokens are JWT-shaped; the refresh token names its account (sub) and session (sid).
enum LiveTokens {
    struct Claims: Equatable { var account: String; var session: String?; var expires: Date? }

    static func claims(_ token: String) -> Claims? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var text = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        text += String(repeating: "=", count: (4 - text.count % 4) % 4)
        guard let bytes = Data(base64Encoded: text),
              let body = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let account = body["sub"] as? String else { return nil }
        return Claims(account: account, session: body["sid"] as? String,
                      expires: (body["exp"] as? Double).map(Date.init(timeIntervalSince1970:)))
    }

    static func expiration(_ cookie: HTTPCookie) -> Date {
        min(cookie.expiresDate ?? .distantFuture, claims(cookie.value)?.expires ?? .distantFuture)
    }
}

actor LiveSession: PlaylistTokens {
    typealias LoginRecovery = @Sendable () async throws -> [HTTPCookie]

    nonisolated let site: URL
    nonisolated let jar: CookieJar
    private let http: URLSession
    private let loginRecovery: LoginRecovery?
    private enum Renewal { case idle, renewing(Task<Void, Error>), cooldown(until: Date, failure: Error) }
    private var renewal = Renewal.idle
    private var stream: (header: String, expires: Date)?
    private var streamRenewal: Task<Void, Error>?
    private var maintenance: Task<Void, Never>?

    init(site: URL, jar: CookieJar, configuration: URLSessionConfiguration? = nil, loginRecovery: LoginRecovery? = nil) {
        self.site = site
        self.jar = jar
        let configuration = configuration ?? .ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        http = URLSession(configuration: configuration)
        self.loginRecovery = loginRecovery
    }

    private nonisolated func cookie(_ name: String) -> HTTPCookie? {
        jar.cookies(for: site).filter { $0.name == name && LiveTokens.expiration($0) > Date() }
            .max { (LiveTokens.expiration($0)) < (LiveTokens.expiration($1)) }
    }

    // A refresh token (or a way to get the first one) is all a session needs.
    nonisolated var signedIn: Bool { cookie("refresh_token") != nil || loginRecovery != nil }

    // MARK: the session

    // The session token, renewed a few minutes before it expires; an expired one waits for the
    // renewal.
    func sessionToken() async throws -> String {
        if let token = cookie("session_token"), LiveTokens.expiration(token).timeIntervalSinceNow > 120 { return token.value }
        try await refresh()
        guard let token = cookie("session_token") else { throw LiveError.loginRequired }
        return token.value
    }

    // One renewal at a time, shared by its callers. A failure is answered again for 30 s
    // instead of asking the site (or the PC) once per request.
    func refresh() async throws {
        switch renewal {
        case .renewing(let task): return try await task.value
        case .cooldown(let until, let failure) where Date() < until: throw failure
        default: break
        }
        let task = Task { try await self.renew() }
        renewal = .renewing(task)
        do {
            try await task.value
            renewal = .idle
        } catch {
            renewal = .cooldown(until: Date().addingTimeInterval(30), failure: error)
            throw error
        }
    }

    // A network change, the app coming back, a pull: the next request may try again at once.
    func retryAfterConnectionChange() {
        if case .cooldown = renewal { renewal = .idle }
    }

    private func renew() async throws {
        guard let refresh = cookie("refresh_token"), let claims = LiveTokens.claims(refresh.value), let session = claims.session else {
            try await adoptLogin()
            return
        }
        var request = URLRequest(url: site.appendingPathComponent("api/session/refresh"), timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue(header(["refresh_token", "device_id"]), forHTTPHeaderField: "Cookie")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["accountId": claims.account, "sessionId": session])
        let (data, response) = try await http.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 || status == 424 || status == 400 {
            // The family is spent, revoked or unknown: a new one from the PC, else a login.
            jar.remove { ["refresh_token", "session_token", "device_id"].contains($0.name) }
            jar.flush()
            if loginRecovery != nil { return try await adoptLogin() }
            throw LiveError.loginRequired
        }
        guard status == 200, let http = response as? HTTPURLResponse else {
            throw LiveError.failed("The site's session renewal answered \(status): \(String(decoding: data.prefix(160), as: UTF8.self))")
        }
        // The rotated refresh token is saved before anything uses the new session.
        jar.store(from: http)
        jar.flush()
        stream = nil
        guard cookie("session_token") != nil else { throw LiveError.failed("The site's session renewal answered without a session token") }
    }

    private func adoptLogin() async throws {
        guard let loginRecovery else { throw LiveError.loginRequired }
        let cookies = try await loginRecovery()
        guard cookies.contains(where: { $0.name == "refresh_token" }) else { throw LiveError.failed("The PC's login answered without the phone's tokens") }
        jar.remove { ["refresh_token", "session_token", "device_id"].contains($0.name) }
        jar.set(cookies)
        jar.flush()
        stream = nil
    }

    private nonisolated func header(_ names: [String], session: String? = nil) -> String {
        var values = names.compactMap { name in cookie(name).map { "\(name)=\($0.value)" } }
        if let session { values.append("session_token=\(session)") }
        return values.joined(separator: "; ")
    }

    // An API call with the session; a 401 renews the session once and asks again.
    func send(_ path: String, method: String = "GET", json body: Any? = nil, raw: Data? = nil) async throws -> Data {
        for attempt in 0..<2 {
            let token = try await sessionToken()
            var components = URLComponents(url: site, resolvingAgainstBaseURL: false)!
            let target = path.split(separator: "?", maxSplits: 1)
            components.path = "/" + target[0].trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            if target.count > 1 { components.percentEncodedQuery = String(target[1]) }
            var request = URLRequest(url: components.url!, timeoutInterval: 20)
            request.httpMethod = method
            request.setValue(header(["device_id"], session: token), forHTTPHeaderField: "Cookie")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            if let body {
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            } else if let raw {
                request.httpBody = raw
                request.setValue("text/plain;charset=UTF-8", forHTTPHeaderField: "Content-Type")
            }
            let (data, response) = try await http.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 && attempt == 0 {
                jar.remove { $0.name == "session_token" }
                try await refresh()
                continue
            }
            if status == 401 { throw LiveError.loginRequired }
            guard (200...299).contains(status) else { throw LiveError.failed("\(components.path) answered \(status)") }
            return data
        }
        throw LiveError.loginRequired
    }

    // MARK: the list

    // The followed accounts that are live now, named, in the order the site follows them.
    func live() async throws -> [LiveStream] {
        struct Followings: Decodable { struct Account: Decodable { var accountId: String }; var following: [Account] }
        let followed = try JSONDecoder().decode(Followings.self, from: try await send("api/followings?size=500")).following.map(\.accountId)
        guard !followed.isEmpty else { return [] }
        struct Live: Decodable {
            struct Record: Decodable { struct Stream: Decodable { var accountId: String; var id: String; var masterUrl: String; var status: String }; var stream: Stream }
            var records: [Record]?
        }
        var streams: [LiveStream] = []
        for page in stride(from: 0, to: followed.count, by: 500) {
            let ids = Array(followed[page..<min(page + 500, followed.count)])
            let answer = try JSONDecoder().decode(Live.self, from: try await send("api/live/by-account-ids?pageSize=500", method: "POST", json: ["accountIds": ids]))
            let wanted = Set(ids)
            for record in answer.records ?? [] where record.stream.status == "LIVE" && wanted.contains(record.stream.accountId) {
                streams.append(LiveStream(accountId: record.stream.accountId, streamId: record.stream.id,
                                          masterUrl: rebased(record.stream.masterUrl), name: "", alias: nil, following: true))
            }
        }
        let order = Dictionary(followed.enumerated().map { ($1, $0) }, uniquingKeysWith: { first, _ in first })
        streams.sort { (order[$0.accountId] ?? .max) < (order[$1.accountId] ?? .max) }
        let names = (try? await profiles(streams.map(\.accountId))) ?? [:]
        return streams.map { stream in
            var named = stream
            if let profile = names[stream.accountId] { (named.name, named.alias) = profile }
            return named
        }
    }

    // First names and current aliases (best effort: a stream without one shows its account).
    func profiles(_ accounts: [String]) async throws -> [String: (String, String?)] {
        guard !accounts.isEmpty else { return [:] }
        struct Entry: Decodable {
            struct Profile: Decodable { struct Alias: Decodable { var alias: String }; var firstName: String?; var aliases: [Alias]? }
            var accountId: String; var profile: Profile?
        }
        let answer = try JSONDecoder().decode([String: Entry].self, from: try await send("api/profiles/batch", method: "POST", json: accounts))
        return Dictionary(answer.values.map { ($0.accountId, ($0.profile?.firstName ?? "", $0.profile?.aliases?.first?.alias)) },
                          uniquingKeysWith: { first, _ in first })
    }

    func follow(_ account: String) async throws {
        _ = try await send("api/follow", method: "POST", raw: Data(account.utf8))
    }

    // The site names its own address in a stream's master URL; the phone reaches the site at
    // the address it was given (Info.plist LiveSite), which can differ (a forwarded port).
    nonisolated func rebased(_ address: String) -> String {
        guard var components = URLComponents(string: address), let base = URLComponents(url: site, resolvingAgainstBaseURL: false) else { return address }
        (components.scheme, components.host, components.port) = (base.scheme, base.host, base.port)
        return components.url?.absoluteString ?? address
    }

    // MARK: playback tokens (PlaylistTokens)

    @MainActor func start() { Task { await self.begin() } }
    @MainActor func stop() { Task { await self.end() } }

    private func begin() {
        guard maintenance == nil else { return }
        maintenance = Task {
            while !Task.isCancelled {
                if stream.map({ $0.expires.timeIntervalSinceNow < 4 }) ?? true { try? await refreshStream() }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func end() {
        maintenance?.cancel()
        maintenance = nil
    }

    // A playlist fetched with the current stream tokens; a 401 renews them once more.
    func playlist(_ url: URL) async throws -> (Data, Int) {
        if stream.map({ $0.expires.timeIntervalSinceNow < 2 }) ?? true { try await refreshStream() }
        for attempt in 0..<2 {
            var request = URLRequest(url: url, timeoutInterval: 10)
            request.setValue(stream?.header, forHTTPHeaderField: "Cookie")
            let (data, response) = try await http.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 && attempt == 0 { stream = nil; try await refreshStream(); continue }
            return (data, status)
        }
        throw URLError(.userAuthenticationRequired)
    }

    private func refreshStream() async throws {
        if let streamRenewal { return try await streamRenewal.value }
        let task = Task { try await self.renewStream() }
        streamRenewal = task
        defer { streamRenewal = nil }
        try await task.value
    }

    private func renewStream() async throws {
        for attempt in 0..<2 {
            let token = try await sessionToken()
            let url = site.appendingPathComponent("api/stream/token")
            var request = URLRequest(url: url, timeoutInterval: 10)
            request.setValue("session_token=\(token)", forHTTPHeaderField: "Cookie")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (_, response) = try await http.data(for: request)
            guard let answer = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            if answer.statusCode == 401 && attempt == 0 { jar.remove { $0.name == "session_token" }; try await refresh(); continue }
            if answer.statusCode == 401 { throw LiveError.loginRequired }
            let values = Dictionary(HTTPCookie.cookies(withResponseHeaderFields: (answer.allHeaderFields as? [String: String]) ?? [:], for: url)
                .map { ($0.name, $0.value) }, uniquingKeysWith: { $1 })
            guard answer.statusCode == 200, let value = values["stream_token"], let account = values["stream_account"],
                  let expires = values["stream_expires"] else { throw URLError(.badServerResponse) }
            stream = ("stream_token=\(value); stream_account=\(account); stream_expires=\(expires)",
                      Double(expires).map(Date.init(timeIntervalSince1970:)) ?? Date().addingTimeInterval(10))
            return
        }
    }
}
