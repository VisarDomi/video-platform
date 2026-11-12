import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// The PC's download lists from anywhere, the way Guidance reaches its PC: the home address
// first, briefly, then the public one (Hetzner, environment services/hetzner-pc "pc-apps").
// - Home: the PC's own address; the phone trusts its certificate. When it does not answer
//   (unreachable, timed out, another machine at that address), the request goes to the public
//   address and home is skipped for 45 s, so away from home a dead address is not waited for
//   on every request.
// - Public: only the list calls and Tango's phone session pass there, and its gateway asks
//   for its own key (Info.plist PCAppsKey, a private build input). Without the key the PC is
//   home-only, as before. Recordings (video, save, cut, return) never leave home.
// - An HTTP status from either address is the PC's answer and final.
// - A write is sent once (see `write`).
actor PCReach {
    static let home = URL(string: "https://192.168.1.197:9999")!
    static let away = URL(string: "https://pc-apps.veron3.space/video")!
    static let shared = PCReach(key: (Bundle.main.object(forInfoDictionaryKey: "PCAppsKey") as? String).flatMap { $0.isEmpty ? nil : $0 })

    // Seconds home may take when the public address can still answer; otherwise the 15 s the
    // PC calls always had. Seconds home is skipped after it failed.
    static let homeWait: TimeInterval = 2
    static let wait: TimeInterval = 15
    static let homeRetry: TimeInterval = 45

    struct Answer: Sendable {
        let data: Data
        let status: Int
        let fromHome: Bool
    }

    private let home: URL
    private let away: URL?
    private let key: String?
    private let session: URLSession
    private let now: @Sendable () -> Date
    private var homeFailed = Date.distantPast

    init(home: URL = PCReach.home, away: URL = PCReach.away, key: String?, session: URLSession = .shared,
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.home = home
        self.away = key == nil ? nil : away
        self.key = key
        self.session = session
        self.now = now
    }

    // A read: the first address that answers.
    func read(_ path: String, query: [String: String] = [:]) async throws -> Answer {
        try await reach(path, query)
    }

    // A write is sent once, to the address that just answered `probe` (a read), and never
    // again on the other address: adding a streamer also follows them from the PC's account,
    // and a write whose answer was lost must not be repeated behind the owner's back.
    func write(_ path: String, json: Data, probe: String, probeQuery: [String: String] = [:]) async throws -> Answer {
        let reached = try await reach(probe, probeQuery)
        guard (200...299).contains(reached.status) else { return reached }
        return try await ask(home: reached.fromHome, path, [:], body: json, timeout: Self.wait)
    }

    private func reach(_ path: String, _ query: [String: String]) async throws -> Answer {
        guard away != nil else { return try await ask(home: true, path, query, body: nil, timeout: Self.wait) }
        // A clock set back must not skip home for longer than 45 s.
        if !(0..<Self.homeRetry).contains(now().timeIntervalSince(homeFailed)) {
            do { return try await ask(home: true, path, query, body: nil, timeout: Self.homeWait) }
            catch {
                // The caller gave up: that says nothing about the address.
                if Task.isCancelled { throw error }
                homeFailed = now()
            }
        }
        return try await ask(home: false, path, query, body: nil, timeout: Self.wait)
    }

    private func ask(home atHome: Bool, _ path: String, _ query: [String: String], body: Data?, timeout: TimeInterval) async throws -> Answer {
        var components = URLComponents(url: (atHome ? home : away ?? home).appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        if !query.isEmpty { components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        var request = URLRequest(url: components.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        if !atHome, let key { request.setValue(key, forHTTPHeaderField: "X-PC-Apps-Key") }
        let (data, status) = try await load(request)
        return Answer(data: data, status: status, fromHome: atHome)
    }

    private func load(_ request: URLRequest) async throws -> (Data, Int) {
        let session = session
        return try await withCheckedThrowingContinuation { continuation in
            session.dataTask(with: request) { data, response, error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: (data ?? Data(), (response as? HTTPURLResponse)?.statusCode ?? 0)) }
            }.resume()
        }
    }
}
