import Foundation

// The PC's website API, which the native viewer calls itself: a recording's save, cut and return
// (packages/app src/providers/local.ts) and the download lists behind the +/- button
// (src/services/downloadList.ts). The phone trusts the PC's certificate.
enum ViewerPC {
    static let server = URL(string: "https://192.168.1.197:9999")!
    static let listNames = ["tango": "Tango", "fc2": "FC2", "sc": "SC"]

    struct Failure: LocalizedError {
        let status: Int
        let message: String
        var errorDescription: String? { message }
    }

    @discardableResult
    static func request(_ path: String, query: [String: String] = [:], json: Any? = nil, post: Bool = false) async throws -> Any? {
        var components = URLComponents(url: server.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: components.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        if post || json != nil { request.httpMethod = "POST" }
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let body = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        guard (200...299).contains(status) else {
            throw Failure(status: status, message: (body as? [String: Any])?["error"] as? String ?? "\(path) failed: \(status)")
        }
        return body
    }

    // Saving keeps the whole recording; cutting keeps the named segments; returning undoes either.
    static func save(_ video: ViewerVideo) async throws {
        try await request("api/videos/\(video.filename)/edited", query: ["provider": video.provider], post: true)
    }
    static func cut(_ video: ViewerVideo, keep: [String]) async throws {
        try await request("api/edit", json: ["filename": video.filename, "segments": keep, "provider": video.provider])
    }
    static func returnOriginal(_ video: ViewerVideo) async throws {
        try await request("api/videos/\(video.filename)/original", query: ["provider": video.provider], post: true)
    }

    static func member(_ list: String, _ identifier: String) async throws -> Bool {
        guard let member = (try await request("api/\(list)/member", query: ["identifier": identifier]) as? [String: Any])?["member"] as? Bool
        else { throw Failure(status: 0, message: "Download-list membership was not answered") }
        return member
    }
    static func exists(_ list: String, _ identifier: String) async throws -> Bool {
        guard let exists = (try await request("api/\(list)/exists", query: ["identifier": identifier]) as? [String: Any])?["exists"] as? Bool
        else { throw Failure(status: 0, message: "The provider lookup was not answered") }
        return exists
    }
    static func change(_ list: String, _ identifier: String, add: Bool) async throws {
        let result = try await request("api/\(list)/\(add ? "add" : "remove")", json: ["identifier": identifier]) as? [String: Any]
        guard result?["success"] as? Bool == true else { throw Failure(status: 0, message: "Download-list update was not confirmed") }
    }
}

// The streamer's membership: one list, or (Video Vault's uploads) whichever lists have them.
// Adding an upload's streamer asks every provider who has a streamer by that name: one adds at
// once, several are offered, none shows 🔍.
@MainActor
final class Membership {
    let info: MembershipInfo
    private var listedIn: [String] = []

    init(_ info: MembershipInfo) { self.info = info }

    func isMember() async throws -> Bool {
        var answers: [String: Bool] = [:]
        try await withThrowingTaskGroup(of: (String, Bool).self) { group in
            for list in info.lists {
                let identifier = info.identifier
                group.addTask { (list, try await ViewerPC.member(list, identifier)) }
            }
            for try await (list, member) in group { answers[list] = member }
        }
        listedIn = info.lists.filter { answers[$0] == true }
        return !listedIn.isEmpty
    }

    // Lists by name a change can go to; nil when there is no choice to make.
    func targets(add: Bool) async throws -> [String]? {
        guard info.choose else { return nil }
        if !add { return listedIn.compactMap { ViewerPC.listNames[$0] } }
        var found: [String: Bool] = [:]
        try await withThrowingTaskGroup(of: (String, Bool).self) { group in
            for list in info.lists {
                let identifier = info.identifier
                group.addTask { (list, try await ViewerPC.exists(list, identifier)) }
            }
            for try await (list, exists) in group { found[list] = exists }
        }
        return info.lists.filter { found[$0] == true }.compactMap { ViewerPC.listNames[$0] }
    }

    func change(add: Bool, target: String?) async throws {
        let list = target.flatMap { name in ViewerPC.listNames.first { $0.value == name }?.key } ?? (info.choose ? nil : info.lists.first)
        guard let list else { throw ViewerPC.Failure(status: 0, message: "Choose a download list.") }
        try await ViewerPC.change(list, info.identifier, add: add)
    }
}
