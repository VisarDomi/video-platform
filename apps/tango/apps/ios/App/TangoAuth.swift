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
        let (data,response) = try await client.data(for:request)
        guard let http = response as? HTTPURLResponse else { throw AuthFailure.invalid }
        return (data,http.statusCode)
    }

    private func refreshSession() async throws {
        guard let fields = currentLogin().session else { throw AuthFailure.login }
        let body = String(decoding:try JSONSerialization.data(withJSONObject:fields),as:UTF8.self)
        let (_, code) = try await perform(URL(string:"https://gateway.tango.me/session-service/public/v2/session/web/refresh")!,
            method:"POST",headers:["Content-Type":"application/json"],body:body)
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
        return (data,http)
    }

    func request(_ input: Data) async throws -> String {
        let args = try JSONSerialization.jsonObject(with:input) as? [String:Any] ?? [:]
        guard let raw = args["url"] as? String, let url = URL(string:raw), url.scheme == "https",
              url.user == nil, url.password == nil,
              (url.host == "gateway.tango.me" && url.port == nil && !url.path.contains("session/") && !url.path.hasSuffix("/tokenData"))
                || (url.host == "192.168.1.197" && url.port == 9999 && url.path.hasPrefix("/api/tango/"))
        else { throw AuthFailure.invalid }
        if url.host == "gateway.tango.me" { try await ensureSession() }
        let (data,code) = try await perform(url,method:args["method"] as? String ?? "GET",
            headers:args["headers"] as? [String:String] ?? [:],body:args["body"] as? String)
        return String(decoding:try JSONSerialization.data(withJSONObject:["status":code,"text":String(decoding:data,as:UTF8.self)]),as:UTF8.self)
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
