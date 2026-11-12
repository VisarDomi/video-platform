import Foundation
import CryptoKit
import KitCore
import KitNet

// One durable request ID owns the phone's browser handoff across cancellation,
// lost responses and app relaunch. The PC retains its answer until acknowledged.
@MainActor
final class TangoPCLogin {
    // The PC at home, and away from home through its public address, whose gateway asks for
    // its own key (Info.plist PCAppsKey; environment services/hetzner-pc "pc-apps").
    nonisolated static let endpoints = [URL(string: "https://192.168.1.197:9999")!]
    nonisolated static let away = URL(string: "https://pc-apps.veron3.space/video")!
    private let bases: [URL]
    private let gateway: (base: URL, key: String)?
    private let key: String
    private let http: HTTPClient
    private let pendingFile: URL?
    private var selected: URL?
    private enum LoginOperation { case idle, connecting(Task<[HTTPCookie], Error>) }
    private var operation = LoginOperation.idle
    private struct Pending: Codable { var id: String; var owner: String }
    private var pending: Pending?

    init?(directory: URL? = nil, key supplied: String? = nil, endpoints: [URL] = TangoPCLogin.endpoints,
          away: URL = TangoPCLogin.away, gatewayKey suppliedGateway: String? = nil,
          configure: (@Sendable (URLSessionConfiguration) -> Void)? = nil) {
        guard let key = supplied ?? Bundle.main.object(forInfoDictionaryKey: "TangoPhoneKey") as? String, !key.isEmpty else { return nil }
        self.key = key
        // Without the gateway's key the PC is asked at home only.
        if let gatewayKey = suppliedGateway ?? Bundle.main.object(forInfoDictionaryKey: "PCAppsKey") as? String, !gatewayKey.isEmpty {
            gateway = (away, gatewayKey); bases = endpoints + [away]
        } else {
            gateway = nil; bases = endpoints
        }
        pendingFile = directory?.appendingPathComponent("tango-pc-request.json")
        pending = pendingFile.flatMap { try? DurableFile.readJSON(Pending.self, from: $0) }
        http = HTTPClient(.init(connectionsPerHost: 2, requestTimeout: 200, resourceTimeout: 220, configure: configure))
    }

    // The phone's key for the PC, plus the gateway's key on the public address.
    private func headers(_ base: URL, _ more: [String: String] = [:]) -> [String: String] {
        Self.headers(base, key: key, gateway: gateway, more)
    }
    nonisolated private static func headers(_ base: URL, key: String, gateway: (base: URL, key: String)?, _ more: [String: String] = [:]) -> [String: String] {
        var headers = more
        headers["X-Phone-Key"] = key
        if let gateway, gateway.base == base { headers["X-PC-Apps-Key"] = gateway.key }
        return headers
    }

    func available() async -> Bool {
        let (http, key, bases, gateway) = (http, key, bases, gateway)
        let endpoint = await withTaskGroup(of: URL?.self, returning: URL?.self) { group in
            for base in bases { group.addTask {
                guard let response = try? await http.send(HTTPRequest(base.appendingPathComponent("api/tango/phone-session"),
                    headers: Self.headers(base, key: key, gateway: gateway), retry: .never, timeout: 3, accept: Set(300...599))), response.status == 200,
                      (try? response.json([String: Bool].self))?["available"] == true else { return nil }
                return base
            } }
            for await answer in group { if let answer { group.cancelAll(); return answer } }
            return nil
        }
        selected = endpoint
        return endpoint != nil
    }

    func newSession(refreshToken: String? = nil) async throws -> [HTTPCookie] {
        if case .connecting(let task) = operation { return try await task.value }
        let task = Task {
            defer { self.operation = .idle }
            return try await self.perform(refreshToken: refreshToken)
        }
        operation = .connecting(task)
        return try await task.value
    }

    private func perform(refreshToken: String?) async throws -> [HTTPCookie] {
        let owner = SHA256.hash(data: Data((refreshToken ?? "new-login").utf8)).map { String(format: "%02x", $0) }.joined()
        if pending?.owner != owner {
            let fresh = Pending(id: UUID().uuidString, owner: owner)
            if let pendingFile { try DurableFile.writeJSON(fresh, to: pendingFile) }
            pending = fresh
        }
        guard let pending, await available(), let selected else { throw TangoError.verificationRequired }
        let headers = headers(selected, ["X-Phone-Request-ID": pending.id, "Content-Type": "application/json"])
        // The persistent phone profile is the sole RT owner. Native credentials
        // are never sent back for another process to replay or overwrite it.
        let body = Data("{\"setup\":true}".utf8)
        let response = try await http.send(HTTPRequest(selected.appendingPathComponent("api/tango/phone-session"), method: "POST",
            headers: headers, body: body, retry: .never, accept: Set(300...599)))
        struct Answer: Decodable {
            struct Cookie: Decodable { var name: String; var value: String; var domain: String; var path: String; var expires: Double? }
            var cookies: [Cookie]?
            var error: String?
        }
        let answer = try response.json(Answer.self)
        guard response.status == 200, let cookies = answer.cookies else { throw TangoError.failed(answer.error ?? "The PC answered \(response.status)") }
        return cookies.compactMap { cookie in
            var properties: [HTTPCookiePropertyKey: Any] = [.name: cookie.name, .value: cookie.value, .domain: cookie.domain, .path: cookie.path,
                .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE"]
            if let expires = cookie.expires { properties[.expires] = Date(timeIntervalSince1970: expires) }
            return HTTPCookie(properties: properties)
        }
    }

    func acceptedSession() {
        guard let pending else { return }
        self.pending = nil
        if let pendingFile { try? FileManager.default.removeItem(at: pendingFile) }
        guard let selected else { return }
        let (http, headers) = (http, headers(selected, ["X-Phone-Request-ID": pending.id]))
        Task {
            _ = try? await http.send(HTTPRequest(selected.appendingPathComponent("api/tango/phone-session"), method: "DELETE",
                headers: headers, retry: .never, timeout: 5, accept: Set(300...599)))
        }
    }
}
