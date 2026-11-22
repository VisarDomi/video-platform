import Foundation
import KitCore
import KitNet

// The phone's first login to a live site, from the PC (/api/<site>/phone-session, packages/server
// phone-session.routes.ts): the PC signs in with its own account and asks the site for a token
// family of the phone's own, which it hands over once. The PC keeps none of it, and the phone
// renews it by itself from then on (LiveSession).
//
// One durable request ID owns a handoff across cancellation, a lost answer and a relaunch: the PC
// answers the same request ID with the same tokens until the phone acknowledges them, so a retry
// never spends a second family. The PC asks for the phone's key (Info.plist PhoneKey, a private
// build input); away from home also for its gateway's (PCAppsKey).
@MainActor
final class LivePCLogin {
    private let site: String
    private let host: String
    private let key: String
    private let bases: [URL]
    private let gatewayKey: String?
    private let http: HTTPClient
    private let pendingFile: URL
    private struct Pending: Codable { var id: String }
    private var pending: Pending?
    private var selected: URL?
    private var running: Task<[HTTPCookie], Error>?

    // The site's ID (the route), the host the phone reaches the site at (its cookies' domain).
    init?(site: String, host: String, directory: URL, key supplied: String? = nil,
          home: URL = PCReach.home, away: URL? = PCReach.away, gatewayKey suppliedGateway: String? = nil) {
        guard let key = supplied ?? Bundle.main.object(forInfoDictionaryKey: "PhoneKey") as? String, !key.isEmpty else { return nil }
        self.site = site
        self.host = host
        self.key = key
        let gateway = suppliedGateway ?? (Bundle.main.object(forInfoDictionaryKey: "PCAppsKey") as? String).flatMap { $0.isEmpty ? nil : $0 }
        gatewayKey = gateway
        bases = [home] + (gateway != nil ? [away].compactMap { $0 } : [])
        pendingFile = directory.appendingPathComponent("\(site)-pc-request.json")
        pending = try? DurableFile.readJSON(Pending.self, from: pendingFile)
        http = HTTPClient(.init(connectionsPerHost: 2, requestTimeout: 200, resourceTimeout: 220))
    }

    private var route: String { "api/\(site)/phone-session" }

    private func headers(_ base: URL, _ more: [String: String] = [:]) -> [String: String] {
        var headers = more
        headers["X-Phone-Key"] = key
        if let gatewayKey, base != bases.first { headers["X-PC-Apps-Key"] = gatewayKey }
        return headers
    }

    // The first PC address that answers that it can log in.
    func available() async -> Bool {
        for base in bases {
            let request = HTTPRequest(base.appendingPathComponent(route), headers: headers(base), retry: .never, timeout: 4, accept: Set(200...599))
            if let response = try? await http.send(request), response.status == 200,
               (try? response.json([String: Bool].self))?["available"] == true {
                selected = base
                return true
            }
        }
        selected = nil
        return false
    }

    // The phone's tokens, as cookies of the site's host. Concurrent callers share one handoff.
    func newSession() async throws -> [HTTPCookie] {
        if let running { return try await running.value }
        let task = Task { try await self.perform() }
        running = task
        defer { running = nil }
        return try await task.value
    }

    private func perform() async throws -> [HTTPCookie] {
        if pending == nil {
            let fresh = Pending(id: UUID().uuidString)
            try DurableFile.writeJSON(fresh, to: pendingFile)
            pending = fresh
        }
        guard let pending, await available(), let selected else {
            throw LiveError.failed("The PC is not reachable to sign this phone in.")
        }
        let response = try await http.send(HTTPRequest(selected.appendingPathComponent(route), method: "POST",
            headers: headers(selected, ["X-Phone-Request-ID": pending.id, "Content-Type": "application/json"]),
            body: Data("{\"setup\":true}".utf8), retry: .never, accept: Set(200...599)))
        struct Answer: Decodable {
            struct Cookie: Decodable { var name: String; var value: String; var path: String?; var expires: Double? }
            var cookies: [Cookie]?
            var error: String?
        }
        let answer = try response.json(Answer.self)
        guard response.status == 200, let cookies = answer.cookies else {
            throw LiveError.failed(answer.error ?? "The PC answered \(response.status)")
        }
        return cookies.compactMap { cookie in
            // The site names its own host; the phone keeps them for the host it reaches it at.
            var properties: [HTTPCookiePropertyKey: Any] = [.name: cookie.name, .value: cookie.value, .domain: host,
                                                            .path: cookie.path ?? "/", HTTPCookiePropertyKey("HttpOnly"): "TRUE"]
            if let expires = cookie.expires, expires > 0 { properties[.expires] = Date(timeIntervalSince1970: expires) }
            return HTTPCookie(properties: properties)
        }
    }

    // The tokens worked: the PC may forget them.
    func accepted() {
        guard let pending else { return }
        self.pending = nil
        try? FileManager.default.removeItem(at: pendingFile)
        guard let selected else { return }
        let request = HTTPRequest(selected.appendingPathComponent(route), method: "DELETE",
                                  headers: headers(selected, ["X-Phone-Request-ID": pending.id]), retry: .never, timeout: 5, accept: Set(200...599))
        let http = http
        Task { _ = try? await http.send(request) }
    }
}
