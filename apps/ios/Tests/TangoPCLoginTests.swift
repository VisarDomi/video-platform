import Foundation
import KitCore
import KitNet

private final class BrokerHTTP: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    static var failNext = false
    static var ids: [String] = []
    static var hosts: [String] = []
    static var gatewayKeys: [String: Set<String>] = [:]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let method = request.httpMethod ?? "GET"
        Self.lock.withLock { Self.gatewayKeys[request.url!.host!, default: []].insert(request.value(forHTTPHeaderField: "X-PC-Apps-Key") ?? "") }
        if method == "POST" {
            let fail = Self.lock.withLock { () -> Bool in
                Self.ids.append(request.value(forHTTPHeaderField: "X-Phone-Request-ID") ?? "")
                Self.hosts.append(request.url!.host!)
                let fail = Self.failNext; Self.failNext = false; return fail
            }
            if fail { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return }
        }
        let status = request.url!.host == "lan.invalid" ? 503 : 200
        let data = method == "POST" ? #"{"cookies":[{"name":"Tango-RT","value":"fixture","domain":"gateway.tango.me","path":"/"}]}"# : #"{"available":true}"#
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(data.utf8)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main
struct TangoPCLoginTests {
    @MainActor static func main() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tango-broker-"+UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        func client() -> TangoPCLogin {
            TangoPCLogin(directory: directory, key: "fixture-key", endpoints: [URL(string:"https://lan.invalid")!, URL(string:"https://remote.invalid")!],
                configure: { $0.protocolClasses = [BrokerHTTP.self] })!
        }
        let first = client()
        let available = await first.available()
        precondition(available, "A healthy remote endpoint works when LAN is down")
        BrokerHTTP.lock.withLock { BrokerHTTP.failNext = true }
        do { _ = try await first.newSession(refreshToken:"fixture-owned-refresh"); fatalError("Lost response must report failure") } catch {}
        let pending = directory.appendingPathComponent("tango-pc-request.json")
        precondition(FileManager.default.fileExists(atPath:pending.path), "Handoff identity is durable before dispatch")
        let pendingText = try String(contentsOf:pending,encoding:.utf8)
        precondition(!pendingText.contains("fixture-owned-refresh"), "Durable request metadata contains no token")
        let restored = client()
        async let a = restored.newSession(refreshToken:"fixture-owned-refresh")
        async let b = restored.newSession(refreshToken:"fixture-owned-refresh")
        _ = try await a; _ = try await b
        let (ids,hosts) = BrokerHTTP.lock.withLock { (BrokerHTTP.ids, BrokerHTTP.hosts) }
        precondition(ids.count==2 && ids[0]==ids[1] && !ids[0].isEmpty, "Relaunch and concurrent retries retain one handoff ID")
        precondition(hosts.allSatisfy{$0=="remote.invalid"}, "Unavailable LAN never receives the credential POST")
        restored.acceptedSession()
        precondition(!FileManager.default.fileExists(atPath:pending.path), "Only committed credentials acknowledge the handoff")
        // Away from home the PC's public address is asked too, and only it gets the gateway's key.
        BrokerHTTP.lock.withLock { BrokerHTTP.gatewayKeys = [:]; BrokerHTTP.hosts = [] }
        let away = TangoPCLogin(directory: directory, key: "fixture-key", endpoints: [URL(string:"https://lan.invalid")!],
            away: URL(string:"https://public.invalid/video")!, gatewayKey: "gateway-fixture", configure: { $0.protocolClasses = [BrokerHTTP.self] })!
        let reachable = await away.available()
        precondition(reachable, "The public address answers when home is down")
        _ = try await away.newSession(refreshToken:"fixture-owned-refresh")
        away.acceptedSession()
        let (keys, posted) = BrokerHTTP.lock.withLock { (BrokerHTTP.gatewayKeys, BrokerHTTP.hosts) }
        precondition(keys["public.invalid"] == ["gateway-fixture"] && keys["lan.invalid"] == [""], "Only the public address gets the gateway key: \(keys)")
        precondition(posted == ["public.invalid"], "The login goes once, to the address that answered")
        let homeOnly = TangoPCLogin(directory: directory, key: "fixture-key", endpoints: [URL(string:"https://lan.invalid")!],
            configure: { $0.protocolClasses = [BrokerHTTP.self] })!
        let unreachable = await homeOnly.available()
        precondition(!unreachable, "Without the gateway key the PC is asked at home only")
        print("PASS: native PC login remote fallback, durable lost-response handoff, one caller and acknowledgment")
    }
}
