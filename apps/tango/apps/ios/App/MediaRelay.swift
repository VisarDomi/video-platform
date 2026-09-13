import Foundation
import Network

// An in-memory, device-local HLS transport. WebKit keeps all rendering and
// gestures. URLs are opaque registrations, never an open URL-forwarding proxy.
actor MediaRelay {
    private let auth: TangoAuth
    private var startupContinuation: CheckedContinuation<Void,Error>?
    private var starting: Task<Void,Error>?
    private var listener: NWListener?
    private var base = ""
    private let secret = UUID().uuidString
    private var links: [String:(url:URL, used:Date)] = [:]
    private var persistent: Set<URL> = []
    private var paths: [URL:String] = [:]
    private(set) var statuses: [Int:Int] = [:]
    private let now: () -> Date
    init(auth: TangoAuth, now: @escaping () -> Date = Date.init) { self.auth = auth; self.now = now }

    func start() async throws {
        if listener != nil { return }
        if let task = starting { try await task.value; return }
        let task = Task { try await self.listen() }
        starting = task
        defer { starting = nil }
        try await task.value
    }
    private func listen() async throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host:"127.0.0.1",port:.any)
        let server = try NWListener(using:parameters)
        server.newConnectionHandler = { [weak self] connection in
            connection.start(queue:DispatchQueue.global(qos:.userInitiated))
            Task { await self?.receive(connection) }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void,Error>) in
            startupContinuation = continuation
            server.stateUpdateHandler = { [weak self] state in
                Task { await self?.listenerState(state) }
            }
            server.start(queue:DispatchQueue.global(qos:.userInitiated))
        }
        guard let port = server.port else { throw AuthFailure.invalid }
        base = "http://127.0.0.1:\(port.rawValue)/\(secret)/"
        listener = server
    }

    private func listenerState(_ state: NWListener.State) {
        guard let continuation = startupContinuation else { return }
        switch state {
        case .ready: startupContinuation=nil; continuation.resume()
        case .failed(let error): startupContinuation=nil; continuation.resume(throwing:error)
        default: break
        }
    }

    func resolve(_ raw: String) async throws -> String {
        guard let url = URL(string:raw), url.scheme == "https", let host = url.host,
              host.hasSuffix(".tango.me"), url.user == nil, url.password == nil else { throw AuthFailure.invalid }
        try await start()
        return register(url, keep: true)
    }
    private func register(_ url: URL, keep: Bool = false) -> String {
        if keep { persistent.insert(url) }
        let key = paths[url] ?? UUID().uuidString
        paths[url] = key; links[key] = (url,now())
        return base + key
    }
    private func rewrite(_ data: Data, from url: URL) throws -> Data {
        guard let text = String(data:data,encoding:.utf8), text.hasPrefix("#EXTM3U") else { throw AuthFailure.invalid }
        let expression = try NSRegularExpression(pattern:"URI=\"([^\"]+)\"")
        let master = text.contains("#EXT-X-STREAM-INF:")
        func mapped(_ raw: String, keep: Bool) throws -> String {
            guard let target = URL(string:raw,relativeTo:url)?.absoluteURL,
                  target.scheme == "https", target.user == nil, target.password == nil else { throw AuthFailure.invalid }
            return register(target, keep: keep)
        }
        let lines = try text.components(separatedBy:"\n").map { line -> String in
            let trimmed = line.trimmingCharacters(in:.whitespacesAndNewlines)
            if trimmed.isEmpty { return line }
            if !trimmed.hasPrefix("#") { return try mapped(trimmed, keep: master) }
            // A cached player may reuse its playlist, key and initialization
            // URLs after backgrounding. Only live segments/parts age out.
            let keep = ["#EXT-X-MEDIA:", "#EXT-X-I-FRAME-STREAM-INF:", "#EXT-X-KEY:",
                        "#EXT-X-SESSION-KEY:", "#EXT-X-MAP:", "#EXT-X-RENDITION-REPORT:"].contains { trimmed.hasPrefix($0) }
            var result = line
            for match in expression.matches(in:line,range:NSRange(line.startIndex...,in:line)).reversed() {
                guard let range = Range(match.range(at:1),in:line) else { continue }
                result.replaceSubrange(range,with:try mapped(String(line[range]), keep: keep))
            }
            return result
        }
        return Data(lines.joined(separator:"\n").utf8)
    }
    private func receive(_ connection: NWConnection, prefix: Data = Data()) {
        connection.receive(minimumIncompleteLength:1,maximumLength:8192) { [weak self] data,_,complete,error in
            var input = prefix; if let data { input.append(data) }
            guard input.count <= 8192, error == nil else { connection.cancel(); return }
            if let text = String(data:input,encoding:.utf8), text.contains("\r\n\r\n") {
                Task { await self?.respond(connection,text) }
            } else if complete { connection.cancel() }
            else { Task { await self?.receive(connection,prefix:input) } }
        }
    }
    private func respond(_ connection: NWConnection, _ header: String) async {
        let first = header.components(separatedBy:"\r\n").first?.components(separatedBy:" ") ?? []
        guard first.count == 3, ["GET","HEAD"].contains(first[0]), first[1].hasPrefix("/\(secret)/"),
              let key = first[1].split(separator:"/").last.map(String.init), let link = links[key] else {
            send(connection,status:404,headers:[:],data:Data()); return
        }
        links[key]?.used = now()
        let range = header.components(separatedBy:"\r\n").first(where:{ $0.lowercased().hasPrefix("range:") })?.dropFirst(6).trimmingCharacters(in:.whitespaces)
        do {
            var (data,response) = try await auth.media(link.url,range:range)
            let status = response.statusCode
            statuses[status,default:0] += 1
            var headers: [String:String] = [:]
            for name in ["Content-Type","Content-Range","Accept-Ranges"] {
                if let value = response.value(forHTTPHeaderField:name) { headers[name] = value }
            }
            if status == 200 && (data.starts(with:Data("#EXTM3U".utf8))) {
                data = try rewrite(data,from:response.url ?? link.url)
                headers["Content-Type"] = "application/vnd.apple.mpegurl"
            }
            // Transient playlists and segments only; no disk cache or download
            // queue. Retire old URL registrations as the live window advances.
            for (old,item) in links where !persistent.contains(item.url) && now().timeIntervalSince(item.used) > 120 {
                links.removeValue(forKey:old); paths.removeValue(forKey:item.url)
            }
            send(connection,status:status,headers:headers,data:first[0] == "HEAD" ? Data() : data, length:data.count)
        } catch { send(connection,status:502,headers:[:],data:Data()) }
    }
    private func send(_ connection: NWConnection, status: Int, headers: [String:String], data: Data, length: Int? = nil) {
        var header = "HTTP/1.1 \(status) Response\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: \(length ?? data.count)\r\n"
        for (key,value) in headers { header += "\(key): \(value)\r\n" }
        var result = Data((header+"\r\n").utf8); result.append(data)
        connection.send(content:result,completion:.contentProcessed { _ in connection.cancel() })
    }
}
