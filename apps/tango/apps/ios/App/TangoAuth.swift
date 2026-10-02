import Foundation

enum AuthFailure: LocalizedError {
    case login, pending, http(Int), invalid
    var errorDescription: String? {
        switch self {
        case .login: return "Tango login is required."
        case .pending: return "Confirm that Tango’s Safari website data has been cleared."
        case .http(let code): return "Tango returned HTTP \(code)."
        case .invalid: return "Invalid Tango response."
        }
    }
}

// One owner across all WK documents. Tasks are single-flight even while this
// actor is reentrant during URLSession awaits. No web page receives the RT.
actor TangoAuth {
    private let readLogin: () throws -> TangoLogin?
    private let saveLogin: (TangoLogin) throws -> Void
    private let now: () -> Date
    private let configuration: () -> URLSessionConfiguration
    init(readLogin: @escaping () throws -> TangoLogin? = LoginStore.load,
         saveLogin: @escaping (TangoLogin) throws -> Void = LoginStore.save,
         configuration: @escaping () -> URLSessionConfiguration = { .ephemeral },
         now: @escaping () -> Date = Date.init) {
        self.readLogin = readLogin; self.saveLogin = saveLogin; self.configuration = configuration; self.now = now
    }
    private var session: URLSession?
    private var jar: HTTPCookieStorage?
    private var loadedToken = ""
    private var refreshed = Date.distantPast
    private var playbackUpdated = Date.distantPast
    private var sessionTask: Task<Void, Error>?
    private var playbackTask: Task<[HTTPCookie], Error>?
    private var needsLogin = false
    private(set) var refreshCount = 0
    private(set) var playbackCount = 0
    private let pc: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        return URLSession(configuration: config, delegate: LocalTrust(host: "192.168.1.197",
            certificateURL: Bundle.main.url(forResource: "LocalCA", withExtension: "cer")), delegateQueue: nil)
    }()

    private func load() throws {
        guard let login = try readLogin() else { throw AuthFailure.login }
        guard login.handoffComplete == true else { throw AuthFailure.pending }
        let token = login.cookies.first(where: { $0.name == "Tango-RT" })?.value ?? ""
        if session != nil && token == loadedToken {
            if needsLogin { throw AuthFailure.login }; return
        }
        let config = configuration()
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        let cookies = config.httpCookieStorage!
        for item in login.cookies {
            if let cookie = HTTPCookie(properties: [.name:item.name, .value:item.value,
                .domain:item.domain, .path:item.path, .secure:"TRUE",
                .expires:Date(timeIntervalSince1970:item.expirationDate)]) { cookies.setCookie(cookie) }
        }
        session?.finishTasksAndInvalidate()
        session = URLSession(configuration:config,delegate:PlaybackRedirects(),delegateQueue:nil); jar = cookies; loadedToken = token
        refreshed = .distantPast; playbackUpdated = .distantPast; needsLogin = false
    }

    private func currentLogin() -> TangoLogin {
        let names: Set<String> = ["Tango-RT", "Tango-DI", "Tango-DeviceId"]
        return TangoLogin(cookies:(jar?.cookies ?? []).filter { names.contains($0.name) }.map {
            LoginCookie(name:$0.name, value:$0.value, domain:$0.domain, path:$0.path,
                        expirationDate:$0.expiresDate?.timeIntervalSince1970 ?? 0)
        }, handoffComplete:true)
    }

    private func perform(_ url: URL, method: String = "GET", headers: [String:String] = [:], body: String? = nil) async throws -> (Data, Int) {
        var request = URLRequest(url:url)
        request.httpMethod = method; request.httpBody = body.map { Data($0.utf8) }
        for (key,value) in headers where ["accept","content-type"].contains(key.lowercased()) {
            request.setValue(value, forHTTPHeaderField:key)
        }
        // Match XHR/fetch string bodies; URLSession otherwise labels POSTs as form data.
        if body != nil && request.value(forHTTPHeaderField:"Content-Type") == nil {
            request.setValue("text/plain;charset=UTF-8", forHTTPHeaderField:"Content-Type")
        }
        let isPC = url.host == "192.168.1.197"
        if !isPC {
            request.setValue("https://www.tango.me", forHTTPHeaderField:"Origin")
            request.setValue("https://www.tango.me/", forHTTPHeaderField:"Referer")
        }
        guard let client = isPC ? pc : session else { throw AuthFailure.login }
        let (data,response) = try await recoverNetworkRead(enabled: !isPC && method == "GET") {
            let result = try await client.data(for:request)
            if !isPC && method == "GET" { try retryableResponse(result.1) }
            return result
        }
        guard let http = response as? HTTPURLResponse else { throw AuthFailure.invalid }
        return (data,http.statusCode)
    }

    private func refreshSession() async throws {
        guard let fields = currentLogin().session else { throw AuthFailure.login }
        let body = String(decoding:try JSONSerialization.data(withJSONObject:fields),as:UTF8.self)
        let code: Int
        do {
            (_, code) = try await perform(URL(string:"https://gateway.tango.me/session-service/public/v2/session/web/refresh")!,
                method:"POST",headers:["Content-Type":"application/json"],body:body)
        } catch {
            // Headers may rotate RT before the body fails. Retain that replacement
            // before the next automatic attempt; never replay the discarded RT.
            let login = currentLogin()
            let token = login.cookies.first(where: { $0.name == "Tango-RT" })?.value ?? ""
            if !token.isEmpty && token != loadedToken { try saveLogin(login); loadedToken = token }
            throw error
        }
        guard code == 200 else {
            if code == 401 || code == 403 { needsLogin = true; throw AuthFailure.login }
            throw AuthFailure.http(code)
        }
        // Persist before tokenData, playback, or any other fallible await. A
        // failed playback request must never discard a rotated refresh token.
        let login = currentLogin()
        try saveLogin(login)
        loadedToken = login.cookies.first(where: { $0.name == "Tango-RT" })?.value ?? ""
        refreshed = now(); refreshCount += 1
    }

    private func ensureSession() async throws {
        if let task = sessionTask { try await task.value; return }
        try load()
        if now().timeIntervalSince(refreshed) < 30 * 60 { return }
        let task = Task { try await self.refreshSession() }
        sessionTask = task
        defer { sessionTask = nil }
        try await task.value
    }

    func authenticate() async throws -> [HTTPCookie] {
        if let task = playbackTask { return try await task.value }
        let task = Task { try await self.updatePlayback() }
        playbackTask = task
        defer { playbackTask = nil }
        return try await task.value
    }

    private func updatePlayback() async throws -> [HTTPCookie] {
        try await ensureSession()
        if now().timeIntervalSince(playbackUpdated) >= 4 {
            var (_, code) = try await perform(URL(string:"https://gateway.tango.me/proxycador/api/public/v1/live/stream/v1/tokenData")!)
            if code == 401 || code == 403 {
                refreshed = .distantPast
                try await ensureSession()
                (_, code) = try await perform(URL(string:"https://gateway.tango.me/proxycador/api/public/v1/live/stream/v1/tokenData")!)
            }
            guard code == 200 else { throw AuthFailure.http(code) }
            playbackUpdated = now(); playbackCount += 1
        }
        let cookies = (jar?.cookies ?? []).filter { ["tt","ttu","tte"].contains($0.name) }
        guard Set(cookies.map(\.name)) == Set(["tt","ttu","tte"]) else { throw AuthFailure.invalid }
        return cookies
    }

    func finishPendingRefresh() async {
        if let task = sessionTask { _ = try? await task.value }
        if let task = playbackTask { _ = try? await task.value }
    }

    func media(_ url: URL, range: String?) async throws -> (Data, HTTPURLResponse) {
        return try await recoverNetworkRead {
        _ = try await authenticate()
        guard url.scheme == "https", let host = url.host, url.user == nil, url.password == nil else { throw AuthFailure.invalid }
        var request = URLRequest(url:url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let range, range.hasPrefix("bytes="), range.count < 100 { request.setValue(range,forHTTPHeaderField:"Range") }
        if host == "tango.me" || host.hasSuffix(".tango.me") {
            // Playback cookies may originate on the gateway. The TL relay also
            // supplied these explicitly to cinema hosts; never send RT or ST.
            let cookies = (jar?.cookies ?? []).filter { ["tt","ttu","tte"].contains($0.name) }
            request.setValue(cookies.map { "\($0.name)=\($0.value)" }.joined(separator:"; "),forHTTPHeaderField:"Cookie")
        }
        guard let session else { throw AuthFailure.login }
        let (data,response) = try await session.data(for:request)
        guard let http = response as? HTTPURLResponse else { throw AuthFailure.invalid }
        try retryableResponse(http)
        return (data,http)
        }
    }

    func request(_ input: Data) async throws -> String {
        let args = try JSONSerialization.jsonObject(with:input) as? [String:Any] ?? [:]
        guard let raw = args["url"] as? String, let url = URL(string:raw), url.scheme == "https",
              url.user == nil, url.password == nil,
              (url.host == "gateway.tango.me" && url.port == nil && !url.path.contains("session/") && !url.path.hasSuffix("/tokenData"))
                || (url.host == "192.168.1.197" && url.port == 9999 && url.path.hasPrefix("/api/tango/"))
        else { throw AuthFailure.invalid }
        let method = args["method"] as? String ?? "GET"
        // Tango's list and batch-profile reads use POST. Account mutations and PC
        // commands are deliberately excluded from automatic replay.
        let read = method == "GET" || (method == "POST" && (
            ["/recommendator/social/v2/list/following", "/recommendator/social/v2/list/following_recommendations"].contains(url.path) ||
            url.path == "/proxycador/api/public/v1/profiles/v2/batch"))
        return try await recoverNetworkRead(enabled: url.host == "gateway.tango.me" && read) {
            if url.host == "gateway.tango.me" { try await ensureSession() }
            let (data,code) = try await perform(url,method:method,
                headers:args["headers"] as? [String:String] ?? [:],body:args["body"] as? String)
            if read && url.host == "gateway.tango.me" {
                try retryableResponse(HTTPURLResponse(url:url,statusCode:code,httpVersion:nil,headerFields:nil)!)
            }
            return String(decoding:try JSONSerialization.data(withJSONObject:["status":code,"text":String(decoding:data,as:UTF8.self)]),as:UTF8.self)
        }
    }
}

// A media redirect may leave Tango for its CDN. Drop the explicitly supplied
// playback Cookie header there; normal URLSession domain scoping still applies.
final class PlaybackRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        guard request.url?.scheme == "https" else { completionHandler(nil); return }
        var redirected = request
        if let host = request.url?.host, host != "tango.me" && !host.hasSuffix(".tango.me") {
            redirected.setValue(nil,forHTTPHeaderField:"Cookie")
        }
        completionHandler(redirected)
    }
}

// Only idempotent public reads use this recovery policy. Cancellation terminates
// connectivity waits and backoff immediately; permanent HTTP failures are returned.
private struct RetryableResponse: Error { let after: Double? }
func retryableResponse(_ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse,
          [408, 429, 500, 502, 503, 504].contains(http.statusCode) else { return }
    let header = http.value(forHTTPHeaderField: "Retry-After")
    var after = header.flatMap(Double.init)
    if after == nil, let header {
        let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        after = format.date(from: header)?.timeIntervalSinceNow
    }
    throw RetryableResponse(after: after.flatMap { $0.isFinite ? max(0, $0) : nil })
}
func recoverNetworkRead<T>(enabled: Bool = true, isolation: isolated (any Actor)? = #isolation, _ operation: () async throws -> T) async throws -> T {
    var delay = 1.0
    while true {
        try Task.checkCancellation()
        do { return try await operation() }
        catch {
            try Task.checkCancellation()
            let network = error as? URLError
            let transient = network.map { [.notConnectedToInternet, .networkConnectionLost, .timedOut,
                .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains($0.code) } ?? false
            let response = error as? RetryableResponse
            guard enabled && (transient || response != nil) else { throw error }
            let seconds = max(delay, response?.after ?? 0)
            try await Task.sleep(for: .seconds(seconds))
            delay = min(delay * 2, 30)
        }
    }
}
