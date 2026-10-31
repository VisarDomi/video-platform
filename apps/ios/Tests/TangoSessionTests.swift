import Foundation
import KitNet

private final class TangoHTTPStub: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    static var status = 424
    static var code = "CHALLENGE_REQUIRED"
    static var requests = 0
    static var access: String?
    static var lastCookie = ""
    private var work: DispatchWorkItem?
    static func reset(_ status: Int = 424, _ code: String = "CHALLENGE_REQUIRED",access:String?=nil) {
        lock.withLock { self.status = status; self.code = code; self.access=access; requests = 0; lastCookie="" }
    }
    static var count: Int { lock.withLock { requests } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, code) = Self.lock.withLock { () -> (Int, String) in Self.requests += 1; Self.lastCookie=request.value(forHTTPHeaderField:"Cookie") ?? ""; return (Self.status, Self.code) }
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            var headers=["Content-Type":"application/json"]
            if let access=Self.lock.withLock({Self.access}){headers["Set-Cookie"]="Tango-ST=\(access); Path=/; Secure"}
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
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
    if let accessSeconds { jar.set([cookie("Tango-ST", token("account", "original"), seconds: accessSeconds)]) }
    return jar
}
private func deviceContext() -> [HTTPCookie] {
    [cookie("Tango-DI","device-identity"),cookie("Tango-DeviceId","installation-id"),cookie("Tango-SD","descriptor")].map { value in var properties=value.properties!;properties[.domain]="www.tango.me";return HTTPCookie(properties:properties)! }
}
private func replacement(_ account: String = "account") -> [HTTPCookie] {
    [cookie("Tango-RT", token(account, "recovered")), cookie("Tango-ST", token(account, "recovered"))] + deviceContext()
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
        let session = TangoSession(jar: sharedJar, configuration: configuration(), loginRecovery: { _ in await probe.called(); return replacement() })
        async let first: Void = session.refresh()
        async let second: Void = session.refresh()
        try await first; try await second
        check(await probe.calls == 1 && TangoHTTPStub.count == 1, "Concurrent requests share one provider refresh and browser recovery")
        check(sharedJar.value("Tango-RT", for: URL(string: "https://gateway.tango.me/")!) == token("account", "recovered"), "Replacement refresh credential committed")
        check(try await session.sessionToken() == token("account", "recovered"), "Recovered access token used")

        TangoHTTPStub.reset()
        let unchanged = jar(), noRecovery = TangoSession(jar: unchanged, configuration: configuration())
        do { try await noRecovery.refresh(); check(false, "Challenge needs verification") }
        catch TangoError.verificationRequired {}
        check(unchanged.value("Tango-RT", for: URL(string: "https://gateway.tango.me/")!) == token("account", "original"), "Challenge keeps the saved credential")
        do { try await noRecovery.refresh(); check(false, "Challenge cooldown") }
        catch TangoError.verificationRequired {}
        check(TangoHTTPStub.count == 1, "Challenge does not hammer the endpoint")

        for (status, code) in [(503, "UNAVAILABLE"), (424, "DEPENDENCY_UNAVAILABLE")] {
            TangoHTTPStub.reset(status, code)
            let counter = RecoveryProbe(), state = jar()
            let transport = TangoSession(jar: state, configuration: configuration(), loginRecovery: { _ in await counter.called(); return replacement() })
            do { try await transport.refresh(); check(false, "Provider outage fails") } catch TangoError.failed(_) {}
            check(await counter.calls == 0, "An outage never creates a new login")
            check(state.value("Tango-RT", for: URL(string: "https://gateway.tango.me/")!) == token("account", "original"), "Outage retains credentials")
        }

        TangoHTTPStub.reset()
        let wrongJar = jar()
        let wrongAccount = TangoSession(jar: wrongJar, configuration: configuration(), loginRecovery: { _ in replacement("different-account") })
        do { try await wrongAccount.refresh(); check(false, "Wrong account rejected") } catch TangoError.verificationRequired {}
        check(wrongJar.value("Tango-RT", for: URL(string: "https://gateway.tango.me/")!) == token("account", "original"), "Recovery cannot silently switch accounts")

        TangoHTTPStub.reset()
        let activeJar = jar(60), gate = RecoveryProbe()
        let active = TangoSession(jar: activeJar, configuration: configuration(), loginRecovery: { _ in await gate.pause(); return replacement() })
        check(try await active.sessionToken() == token("account", "original"), "Usable access token stays available during proactive renewal")
        for _ in 0..<100 { if await gate.calls > 0 { break }; try await Task.sleep(for: .milliseconds(10)) }
        check(await gate.calls == 1, "Proactive verification began")
        check(try await active.sessionToken() == token("account", "original"), "Playback does not wait for the browser")
        await gate.release()
        for _ in 0..<100 { if activeJar.value("Tango-RT", for: URL(string: "https://gateway.tango.me/")!) == token("account", "recovered") { break }; try await Task.sleep(for: .milliseconds(10)) }
        check(try await active.sessionToken() == token("account", "recovered"), "Playback adopts the completed recovery")
        check(await gate.calls == 1, "Proactive renewal remains single flight")
        for code in ["BAD_USERNAME", "SESSION_COMPROMISED", "SESSION_NOT_FOUND"] {
            TangoHTTPStub.reset(401, code)
            let state = jar(), counter = RecoveryProbe()
            let rejected = TangoSession(jar: state, configuration: configuration(), loginRecovery: { _ in await counter.called(); return replacement() })
            try await rejected.refresh()
            check(await counter.calls == 1, "Known rejected session uses the existing PC recovery")
            check(try await rejected.sessionToken() == token("account", "recovered"), "Rejected session adopts coherent fresh credentials")
        }
        TangoHTTPStub.reset(401, "SESSION_NOT_FOUND")
        let held = jar(), unavailable = RecoveryProbe()
        let rejected = TangoSession(jar: held, configuration: configuration(), loginRecovery: { _ in await unavailable.called(); throw TangoError.verificationRequired })
        for _ in 0..<2 {
            await rejected.retryAfterConnectionChange()
            do { try await rejected.refresh(); check(false, "Unavailable broker needs verification") } catch TangoError.verificationRequired {}
        }
        let recoveryAttempts = await unavailable.calls
        check(TangoHTTPStub.count == 1 && recoveryAttempts == 2, "Manual retry does not replay a known rejected RT")

        let coherent = jar(3600)
        check(!Tango.storeLogin([cookie("Tango-RT", token("account", "fresh")), cookie("Tango-ST", token("account", "other-family"))], in: coherent), "Mixed session families are rejected")
        check(coherent.value("Tango-RT", for: URL(string: "https://gateway.tango.me/")!) == token("account", "original"), "Rejected handoff preserves the current login")
        TangoHTTPStub.reset(403, "UNAVAILABLE")
        let blocked = RecoveryProbe()
        let transportBlock = TangoSession(jar: jar(), configuration: configuration(), loginRecovery: { _ in await blocked.called(); return replacement() })
        do { try await transportBlock.refresh(); check(false, "Unclassified access block needs verification") } catch TangoError.verificationRequired {}
        check(await blocked.calls == 0, "An access block without a session rejection never submits a password")
        TangoHTTPStub.reset(200,"OK",access:token("account","original"))
        let setups=RecoveryProbe(), nativeJar=jar()
        nativeJar.set(deviceContext())
        let native=TangoSession(jar:nativeJar,configuration:configuration(),loginRecovery:{ _ in await setups.called();return replacement() })
        try await native.refresh()
        check(await setups.calls == 0 && TangoHTTPStub.count == 1,"Ordinary renewal stays on the phone without a PC/browser login")
        let sent=TangoHTTPStub.lock.withLock{TangoHTTPStub.lastCookie}
        check(sent.contains("Tango-DI=device-identity") && sent.contains("Tango-DeviceId=installation-id") && sent.contains("Tango-SD=descriptor"),"Native refresh sends the complete issued device context")
        check(try await native.sessionToken() == token("account","original"),"Native access renewal commits before returning")
        let shortIdentity=cookie("Tango-DI","device-identity",seconds:10)
        nativeJar.set([shortIdentity])
        check(Tango.storeLogin(replacement().filter{$0.name != "Tango-DI" && $0.name != "Tango-DeviceId"},in:nativeJar),"Fresh credentials retain existing device identifiers")
        check(Tango.credential("Tango-DI",in:nativeJar)?.value == "device-identity","Identifier value is never regenerated during token renewal")
        check(Tango.credential("Tango-DI",in:nativeJar)!.expiresDate! >= Tango.expiration(Tango.credential("Tango-RT",in:nativeJar)!),"Remembered device outlives the rolling refresh credential")
        let empty=CookieJar(file:nil)
        let restored=TangoSession(jar:empty,configuration:configuration(),loginRecovery:{ _ in return replacement() })
        check(restored.signedIn,"Saved setup availability is not shown as a logout")
        check(try await restored.sessionToken() == token("account","recovered"),"Interrupted initial setup resumes without losing its accepted account")
        let pinnedJar=jar()
        let pinned=TangoSession(jar:pinnedJar,diagnosticURL:directory.appendingPathComponent("tango-network.json"),configuration:configuration(),loginRecovery:{ _ in return replacement("wrong-account") })
        pinnedJar.remove{_ in true}
        do{try await pinned.refresh();check(false,"Remembered account cannot silently change after local token expiry")}catch TangoError.verificationRequired{}
        print("PASS: Tango challenge recovery, single ownership, outage/cooldown safety, account preservation and uninterrupted valid-token renewal")
    }
}
