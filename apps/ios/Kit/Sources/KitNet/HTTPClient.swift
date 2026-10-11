import Foundation
import KitCore

public struct HTTPRequest: Sendable {
    public var url: URL
    public var method: String
    public var headers: [String: String]
    public var body: Data?
    // nil uses the client's default Referer.
    public var referer: String?
    // nil: `.reads` for GET and HEAD, `.never` for everything else.
    public var retry: RetryPolicy?
    public var priority: Float
    public var timeout: TimeInterval?
    // Statuses returned instead of thrown, besides 2xx (e.g. 404 meaning "no results").
    public var accept: Set<Int>

    public init(_ url: URL, method: String = "GET", headers: [String: String] = [:], body: Data? = nil, referer: String? = nil,
                retry: RetryPolicy? = nil, priority: Float = URLSessionTask.defaultPriority, timeout: TimeInterval? = nil, accept: Set<Int> = []) {
        self.url = url
        self.method = method
        self.headers = headers
        self.body = body
        self.referer = referer
        self.retry = retry
        self.priority = priority
        self.timeout = timeout
        self.accept = accept
    }

    public static func json(_ url: URL, method: String = "POST", body: some Encodable, referer: String? = nil) throws -> HTTPRequest {
        HTTPRequest(url, method: method, headers: ["Content-Type": "application/json"], body: try JSONEncoder().encode(body), referer: referer)
    }
}

public struct HTTPResponse: Sendable {
    public let data: Data
    public let response: HTTPURLResponse
    public let requestURL: URL

    public var status: Int { response.statusCode }
    public var url: URL { response.url ?? requestURL }
    // A redirect was followed (URLSession follows them; the web's `response.redirected`).
    public var redirected: Bool { url != requestURL }
    public var text: String { String(decoding: data, as: UTF8.self) }
    public func json<T: Decodable>(_ type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T { try decoder.decode(type, from: data) }
    public func header(_ name: String) -> String? { response.value(forHTTPHeaderField: name) }
}

// One client per purpose (a site, the PC, images). Requests carry the app's Referer and user
// agent explicitly, cookies come only from the app's jar, nothing is cached unless asked, and
// cancelling the calling task cancels the transfer. The PC's host is trusted through its
// bundled CA only (LocalTrust).
public final class HTTPClient: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    public struct Configuration: Sendable {
        public var userAgent: String?
        public var referer: String?
        public var cookies: CookieJar?
        public var trust: LocalTrust?
        public var connectionsPerHost: Int
        public var requestTimeout: TimeInterval
        public var resourceTimeout: TimeInterval
        public var waitsForConnectivity: Bool
        public var cache: URLCache?
        // Last word on the session settings (tests install stub protocols here).
        public var configure: (@Sendable (URLSessionConfiguration) -> Void)?

        public init(userAgent: String? = nil, referer: String? = nil, cookies: CookieJar? = nil, trust: LocalTrust? = nil,
                    connectionsPerHost: Int = 8, requestTimeout: TimeInterval = 20, resourceTimeout: TimeInterval = 90,
                    waitsForConnectivity: Bool = false, cache: URLCache? = nil,
                    configure: (@Sendable (URLSessionConfiguration) -> Void)? = nil) {
            self.userAgent = userAgent
            self.referer = referer
            self.cookies = cookies
            self.trust = trust
            self.connectionsPerHost = connectionsPerHost
            self.requestTimeout = requestTimeout
            self.resourceTimeout = resourceTimeout
            self.waitsForConnectivity = waitsForConnectivity
            self.cache = cache
            self.configure = configure
        }
    }

    public let configuration: Configuration
    private var session: URLSession!

    public init(_ configuration: Configuration) {
        self.configuration = configuration
        super.init()
        let session = URLSessionConfiguration.ephemeral
        session.httpCookieStorage = nil
        session.httpShouldSetCookies = false
        session.httpCookieAcceptPolicy = .never
        session.urlCache = configuration.cache
        session.requestCachePolicy = configuration.cache == nil ? .reloadIgnoringLocalCacheData : .useProtocolCachePolicy
        session.httpMaximumConnectionsPerHost = configuration.connectionsPerHost
        session.timeoutIntervalForRequest = configuration.requestTimeout
        session.timeoutIntervalForResource = configuration.resourceTimeout
        session.waitsForConnectivity = configuration.waitsForConnectivity
        configuration.configure?(session)
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        self.session = URLSession(configuration: session, delegate: self, delegateQueue: queue)
    }

    public func invalidate() { session.invalidateAndCancel() }

    public func get(_ url: URL, referer: String? = nil) async throws -> HTTPResponse { try await send(HTTPRequest(url, referer: referer)) }

    public func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let policy = request.retry ?? (["GET", "HEAD"].contains(request.method) ? .reads : .never)
        return try await policy.run { try await once(request) }
    }

    // Downloads into `destination` atomically (DurableFile.commit), checking the size when given.
    public func download(_ request: HTTPRequest, to destination: URL, expectedSize: Int64? = nil,
                         validate: (@Sendable (HTTPURLResponse) throws -> Void)? = nil) async throws -> HTTPURLResponse {
        let policy = request.retry ?? .reads
        return try await policy.run { try await downloadOnce(request, to: destination, expectedSize: expectedSize, validate: validate) }
    }

    public func urlRequest(_ request: HTTPRequest) -> URLRequest {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        if let timeout = request.timeout { urlRequest.timeoutInterval = timeout }
        if let userAgent = configuration.userAgent { urlRequest.setValue(userAgent, forHTTPHeaderField: "User-Agent") }
        if let referer = request.referer ?? configuration.referer { urlRequest.setValue(referer, forHTTPHeaderField: "Referer") }
        for (name, value) in request.headers { urlRequest.setValue(value, forHTTPHeaderField: name) }
        if request.headers["Cookie"] == nil, let cookie = configuration.cookies?.header(for: request.url) {
            urlRequest.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        return urlRequest
    }

    private func once(_ request: HTTPRequest) async throws -> HTTPResponse {
        let urlRequest = urlRequest(request)
        let box = TaskBox()
        let (data, response): (Data, URLResponse) = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let task = session.dataTask(with: urlRequest) { data, response, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let data, let response { continuation.resume(returning: (data, response)) }
                    else { continuation.resume(throwing: URLError(.badServerResponse)) }
                }
                task.priority = request.priority
                box.set(task)
                task.resume()
            }
        } onCancel: { box.cancel() }
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        configuration.cookies?.store(from: http)
        try check(http, request: request, body: data)
        return HTTPResponse(data: data, response: http, requestURL: request.url)
    }

    private func downloadOnce(_ request: HTTPRequest, to destination: URL, expectedSize: Int64?,
                              validate: (@Sendable (HTTPURLResponse) throws -> Void)?) async throws -> HTTPURLResponse {
        let urlRequest = urlRequest(request)
        let box = TaskBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let task = session.downloadTask(with: urlRequest) { [configuration] location, response, error in
                    do {
                        if let error { throw error }
                        guard let location, let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
                        configuration.cookies?.store(from: http)
                        try self.check(http, request: request, body: Data())
                        try validate?(http)
                        try DurableFile.commit(location, to: destination, expectedSize: expectedSize)
                        continuation.resume(returning: http)
                    } catch { continuation.resume(throwing: error) }
                }
                task.priority = request.priority
                box.set(task)
                task.resume()
            }
        } onCancel: { box.cancel() }
    }

    private func check(_ response: HTTPURLResponse, request: HTTPRequest, body: Data) throws {
        let status = response.statusCode
        guard !(200..<300).contains(status), !request.accept.contains(status) else { return }
        throw HTTPStatusError(status: status, url: response.url ?? request.url, retryAfter: HTTPStatusError.retryAfter(response), body: body)
    }

    // MARK: delegate

    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let answer = configuration.trust?.evaluate(challenge) { completionHandler(answer.0, answer.1) }
        else { completionHandler(.performDefaultHandling, nil) }
    }

    // Redirects keep the app's cookies: those set by the redirect are stored, and the next
    // request gets the jar's cookies for its own URL.
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        configuration.cookies?.store(from: response)
        var next = request
        if let url = next.url, let jar = configuration.cookies {
            next.setValue(jar.header(for: url), forHTTPHeaderField: "Cookie")
        }
        completionHandler(next)
    }
}

// The URLSessionTask behind a request, for cancellation from another task.
final class TaskBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var cancelled = false

    func set(_ task: URLSessionTask) {
        let cancel = lock.withLock { () -> Bool in self.task = task; return cancelled }
        if cancel { task.cancel() }
    }

    func cancel() {
        let task = lock.withLock { () -> URLSessionTask? in cancelled = true; return self.task }
        task?.cancel()
    }
}
