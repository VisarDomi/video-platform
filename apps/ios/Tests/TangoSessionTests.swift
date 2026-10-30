import Foundation
import KitNet

private final class TangoHTTPStub: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    static var status = 424
    static var code = "CHALLENGE_REQUIRED"
    static var requests = 0
    private var work: DispatchWorkItem?
    static func reset(_ status: Int = 424, _ code: String = "CHALLENGE_REQUIRED") {
        lock.withLock { self.status = status; self.code = code; requests = 0 }
    }
    static var count: Int { lock.withLock { requests } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, code) = Self.lock.withLock { () -> (Int, String) in Self.requests += 1; return (Self.status, Self.code) }
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            let data = try! JSONSerialization.data(withJSONObject: ["errorCode": code, "errorMessage": "Fixture error"])
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
        work = item
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05, execute: item)
    }
    override func stopLoading() { work?.cancel() }
}

private actor RecoveryProbe {
    var calls = 0
    var gate: CheckedContinuation<Void, Never>?
    var released = false
    func called() { calls += 1 }
    func pause() async {
        calls += 1
        if !released { await withCheckedContinuation { gate = $0 } }
    }
    func release() { released = true; gate?.resume(); gate = nil }
}

private func check(_ condition: Bool, _ text: String) {
    if !condition { print("FAIL: " + text); exit(1) }
}
private func token(_ account: String, _ session: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: ["accountId": account, "sessionId": session], options: [.sortedKeys])
    return "header." + data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") + ".signature"
}
private func cookie(_ name: String, _ value: String, seconds: TimeInterval = 3600) -> HTTPCookie {
    HTTPCookie(properties: [.name: name, .value: value, .domain: "gateway.tango.me", .path: "/", .secure: "TRUE", .expires: Date().addingTimeInterval(seconds)])!
}
private func configuration() -> URLSessionConfiguration {
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [TangoHTTPStub.self]; return config
}
private func jar(_ accessSeconds: TimeInterval? = nil) -> CookieJar {
    let jar = CookieJar(file: nil)
    jar.set([cookie("Tango-RT", token("account", "original"))])
    if let accessSeconds { jar.set([cookie("Tango-ST", "old-access-secret", seconds: accessSeconds)]) }
    return jar
}
private func replacement(_ account: String = "account") -> [HTTPCookie] {
    [cookie("Tango-RT", token(account, "recovered")), cookie("Tango-ST", "new-access-secret")]
}

@main
struct TangoSessionTests {
    static func main() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tango-session-test-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("cookies.json"), stored = CookieJar(file: file)
        var properties = cookie("Tango-RT", token("account", "old-scope")).properties!
        properties[.path] = "/session-service/public/v2/session/web/refresh"
        stored.set([cookie("Tango-RT", token("account", "original")), HTTPCookie(properties: properties)!]); stored.flush()
        Tango.storeLogin(replacement(), in: stored)
        let disk = CookieJar(file: file)
        check(disk.all.filter { $0.name == "Tango-RT" }.allSatisfy { $0.value == token("account", "recovered") }, "Every old credential scope updates in one durable snapshot")
        var modernProperties = cookie("Tango-RT", token("account", "modern")).properties!
        modernProperties[.domain] = "www.tango.me"; modernProperties[.path] = "/api/session-service/public/v2/session/web/refresh"
        let modern = CookieJar(file: nil); modern.set([HTTPCookie(properties: modernProperties)!])
        check(TangoSession(jar: modern).signedIn, "Current first-party cookie paths can restore the native login")

        TangoHTTPStub.reset()
        let sharedJar = jar(), probe = RecoveryProbe()
        let session = TangoSession(jar: sharedJar, configuration: configuration(), loginRecovery: { await probe.called(); return replacement() })
        async let first: Void = session.refresh()
        async let second: Void = session.refresh()
        try await first; try await second
        check(await probe.calls == 1 && TangoHTTPStub.count == 1, "Concurrent requests share one provider refresh and browser recovery")
        check(sharedJar.value("Tango-RT", for: Tango.refreshURL) == token("account", "recovered"), "Replacement refresh credential committed")
        check(try await session.sessionToken() == "new-access-secret", "Recovered access token used")

        TangoHTTPStub.reset()
        let unchanged = jar(), noRecovery = TangoSession(jar: unchanged, configuration: configuration())
        do { try await noRecovery.refresh(); check(false, "Challenge needs verification") }
        catch TangoError.verificationRequired {}
        check(unchanged.value("Tango-RT", for: Tango.refreshURL) == token("account", "original"), "Challenge keeps the saved credential")
        do { try await noRecovery.refresh(); check(false, "Challenge cooldown") }
        catch TangoError.verificationRequired {}
        check(TangoHTTPStub.count == 1, "Challenge does not hammer the endpoint")

        for (status, code) in [(503, "UNAVAILABLE"), (424, "DEPENDENCY_UNAVAILABLE")] {
            TangoHTTPStub.reset(status, code)
            let counter = RecoveryProbe(), state = jar()
            let transport = TangoSession(jar: state, configuration: configuration(), loginRecovery: { await counter.called(); return replacement() })
            do { try await transport.refresh(); check(false, "Provider outage fails") } catch TangoError.failed(_) {}
            check(await counter.calls == 0, "An outage never creates a new login")
            check(state.value("Tango-RT", for: Tango.refreshURL) == token("account", "original"), "Outage retains credentials")
        }

        TangoHTTPStub.reset()
        let wrongJar = jar()
        let wrongAccount = TangoSession(jar: wrongJar, configuration: configuration(), loginRecovery: { replacement("different-account") })
        do { try await wrongAccount.refresh(); check(false, "Wrong account rejected") } catch TangoError.verificationRequired {}
        check(wrongJar.value("Tango-RT", for: Tango.refreshURL) == token("account", "original"), "Recovery cannot silently switch accounts")

        TangoHTTPStub.reset()
        let activeJar = jar(60), gate = RecoveryProbe()
        let active = TangoSession(jar: activeJar, configuration: configuration(), loginRecovery: { await gate.pause(); return replacement() })
        check(try await active.sessionToken() == "old-access-secret", "Usable access token stays available during proactive renewal")
        for _ in 0..<100 { if await gate.calls > 0 { break }; try await Task.sleep(for: .milliseconds(10)) }
        check(await gate.calls == 1, "Proactive verification began")
        check(try await active.sessionToken() == "old-access-secret", "Playback does not wait for the browser")
        await gate.release()
        for _ in 0..<100 { if activeJar.value("Tango-RT", for: Tango.refreshURL) == token("account", "recovered") { break }; try await Task.sleep(for: .milliseconds(10)) }
        check(try await active.sessionToken() == "new-access-secret", "Playback adopts the completed recovery")
        check(await gate.calls == 1, "Proactive renewal remains single flight")
        print("PASS: Tango challenge recovery, single ownership, outage/cooldown safety, account preservation and uninterrupted valid-token renewal")
    }
}
