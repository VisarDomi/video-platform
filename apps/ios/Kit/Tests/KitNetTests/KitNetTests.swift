import Foundation
import Testing
@testable import KitNet

// A stub transport: answers by URL, records requests.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, [String: String], Data))?
    nonisolated(unsafe) static var requests: [URLRequest] = []
    static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, headers, body) = Self.lock.withLock { () -> (Int, [String: String], Data) in
            Self.requests.append(request)
            return Self.handler?(request) ?? (404, [:], Data())
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func client(_ jar: CookieJar? = nil, referer: String? = "https://site.test/") -> HTTPClient {
    HTTPClient(.init(userAgent: "KitTest/1", referer: referer, cookies: jar, configure: { $0.protocolClasses = [StubProtocol.self] }))
}

@Suite(.serialized) struct HTTPClientTests {
    @Test func headersCookiesAndStatus() async throws {
        let jar = CookieJar(file: nil)
        StubProtocol.lock.withLock {
            StubProtocol.requests = []
            StubProtocol.handler = { request in
                if request.url!.path == "/login" { return (200, ["Set-Cookie": "session=abc; Path=/; Secure"], Data("ok".utf8)) }
                if request.url!.path == "/missing" { return (404, [:], Data()) }
                return (200, [:], Data(request.value(forHTTPHeaderField: "Cookie")?.utf8 ?? "".utf8))
            }
        }
        let http = client(jar)
        _ = try await http.get(URL(string: "https://site.test/login")!)
        let echoed = try await http.get(URL(string: "https://site.test/api")!)
        #expect(echoed.text == "session=abc")
        let sent = StubProtocol.lock.withLock { StubProtocol.requests }
        #expect(sent.first?.value(forHTTPHeaderField: "User-Agent") == "KitTest/1")
        #expect(sent.first?.value(forHTTPHeaderField: "Referer") == "https://site.test/")
        await #expect(throws: HTTPStatusError.self) { _ = try await http.send(HTTPRequest(URL(string: "https://site.test/missing")!, retry: .never)) }
        let accepted = try await http.send(HTTPRequest(URL(string: "https://site.test/missing")!, accept: [404]))
        #expect(accepted.status == 404)
    }

    @Test func retriesTransientStatusesThenSucceeds() async throws {
        nonisolated(unsafe) var calls = 0
        StubProtocol.lock.withLock {
            StubProtocol.handler = { _ in calls += 1; return calls < 3 ? (503, ["Retry-After": "0"], Data()) : (200, [:], Data("done".utf8)) }
        }
        let http = client()
        let response = try await http.send(HTTPRequest(URL(string: "https://site.test/flaky")!, retry: RetryPolicy(firstDelay: 0.01, maxDelay: 0.02)))
        #expect(response.text == "done")
        #expect(calls == 3)
    }

    @Test func writesDoNotRetry() async throws {
        nonisolated(unsafe) var calls = 0
        StubProtocol.lock.withLock { StubProtocol.handler = { _ in calls += 1; return (503, [:], Data()) } }
        let http = client()
        await #expect(throws: HTTPStatusError.self) {
            _ = try await http.send(HTTPRequest(URL(string: "https://site.test/save")!, method: "POST", body: Data()))
        }
        #expect(calls == 1)
    }
}

@Test func retryDelays() {
    let policy = RetryPolicy(maxAttempts: 3, hostMissingAttempts: 2)
    #expect(policy.retryDelay(for: URLError(.timedOut), attempt: 1, backoff: 1) == 1)
    #expect(policy.retryDelay(for: URLError(.timedOut), attempt: 3, backoff: 1) == nil)
    #expect(policy.retryDelay(for: URLError(.cannotFindHost), attempt: 2, backoff: 1) == nil)
    #expect(policy.retryDelay(for: URLError(.badURL), attempt: 1, backoff: 1) == nil)
    #expect(policy.retryDelay(for: HTTPStatusError(status: 429, url: nil, retryAfter: 5), attempt: 1, backoff: 1) == 5)
    #expect(policy.retryDelay(for: HTTPStatusError(status: 404, url: nil), attempt: 1, backoff: 1) == nil)
}

@Test func cookieMatchingAndPersistence() throws {
    let file = FileManager.default.temporaryDirectory.appendingPathComponent("kit-cookies-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: file) }
    let jar = CookieJar(file: file)
    let url = URL(string: "https://www.example.com/account/uploads")!
    jar.set(HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "a=1; Domain=.example.com; Path=/"], for: url))
    jar.set(HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "b=2; Path=/account; Secure"], for: url))
    jar.set(HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "old=x; Path=/; Expires=Wed, 01 Jan 2020 00:00:00 GMT"], for: url))
    #expect(jar.header(for: url) == "b=2; a=1")
    #expect(jar.header(for: URL(string: "https://cdn.example.com/")!) == "a=1")
    #expect(jar.header(for: URL(string: "http://www.example.com/account")!) == "a=1")
    #expect(jar.header(for: URL(string: "https://www.example.com/accounts")!) == "a=1")
    jar.flush()
    let reopened = CookieJar(file: file)
    #expect(reopened.header(for: url) == "b=2; a=1")
    reopened.remove { $0.name == "a" }
    #expect(reopened.header(for: url) == "b=2")
}
