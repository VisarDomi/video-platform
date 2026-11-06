import Foundation
import CryptoKit
import KitCore
import KitNet

// One durable request ID owns the phone's browser handoff across cancellation,
// lost responses and app relaunch. The PC retains its answer until acknowledged.
@MainActor
final class TangoPCLogin {
    nonisolated static let endpoints = ["https://192.168.1.197:9999", "https://z440.tailf47c4e.ts.net:9999"].map { URL(string: $0)! }
    private let bases: [URL]
    private let key: String
    private let http: HTTPClient
    private let pendingFile: URL?
    private var selected: URL?
    private enum LoginOperation { case idle, connecting(Task<[HTTPCookie], Error>) }
    private var operation = LoginOperation.idle
    private struct Pending: Codable { var id: String; var owner: String }
    private var pending: Pending?

    init?(directory: URL? = nil, key supplied: String? = nil, endpoints: [URL] = TangoPCLogin.endpoints,
          configure: (@Sendable (URLSessionConfiguration) -> Void)? = nil) {
        guard let key = supplied ?? Bundle.main.object(forInfoDictionaryKey: "TangoPhoneKey") as? String, !key.isEmpty else { return nil }
        self.key = key; bases = endpoints
        pendingFile = directory?.appendingPathComponent("tango-pc-request.json")
        pending = pendingFile.flatMap { try? DurableFile.readJSON(Pending.self, from: $0) }
        http = HTTPClient(.init(connectionsPerHost: 2, requestTimeout: 200, resourceTimeout: 220, configure: configure))
    }

    func available() async -> Bool {
        let (http, key, bases) = (http, key, bases)
        let endpoint = await withTaskGroup(of: URL?.self, returning: URL?.self) { group in
            for base in bases { group.addTask {
                guard let response = try? await http.send(HTTPRequest(base.appendingPathComponent("api/tango/phone-session"),
                    headers: ["X-Phone-Key": key], retry: .never, timeout: 3, accept: Set(300...599))), response.status == 200,
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
        let headers = ["X-Phone-Key": key, "X-Phone-Request-ID": pending.id, "Content-Type": "application/json"]
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
        let (http, key) = (http, key)
        Task {
            _ = try? await http.send(HTTPRequest(selected.appendingPathComponent("api/tango/phone-session"), method: "DELETE",
                headers: ["X-Phone-Key": key, "X-Phone-Request-ID": pending.id], retry: .never, timeout: 5, accept: Set(300...599)))
        }
    }
}
