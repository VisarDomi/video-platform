#if targetEnvironment(simulator)
import UIKit
import KitNet
import KitTestHooks

private final class TangoFixtureHTTP: URLProtocol {
    static let lock = NSLock()
    static var mode = "success"
    static var requests = 0
    static var recoveries = 0
    private var work: DispatchWorkItem?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let mode = Self.lock.withLock { Self.requests += 1; return Self.mode }
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            let refresh = request.url?.path.contains("/session/web/refresh") == true
            let status = mode.hasSuffix("outage") ? 503 : (refresh && mode.hasPrefix("challenge") ? 424 : 200)
            let record: [String: Any] = ["isPublic": true, "anchor": ["encryptedAccountId": "fixture-streamer", "firstName": "Network fixture"],
                                       "stream": ["id": "fixture-stream", "status": "LIVING", "masterListUrl": "https://media.invalid/never-play.m3u8"]]
            let body: [String: Any]
            if status >= 400 { body = ["errorCode": status == 424 ? "CHALLENGE_REQUIRED" : "UNAVAILABLE"] }
            else if request.url?.path.contains("blocklist") == true { body = ["users": [String]()] }
            else { body = ["records": [record]] }
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
            client?.urlProtocolDidFinishLoading(self)
        }
        work = item
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.05, execute: item)
    }
    override func stopLoading() { work?.cancel() }
}

@MainActor
final class TangoNetworkChecks: UIViewController {
    private var list: TangoListController?
    override var prefersStatusBarHidden: Bool { true }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        TestHooks.shared.register("tango-fixture") { [weak self] in self?.fixture($0["mode"] ?? "success") ?? [:] }
        TestHooks.shared.register("tango-network") { [weak self] query in
            let mode = query["mode"] ?? "success"
            TangoFixtureHTTP.lock.withLock { TangoFixtureHTTP.mode = mode }
            self?.list?.networkChanged(signature: "fixture-lost", reachable: false)
            self?.list?.networkChanged(signature: "fixture-" + mode, reachable: true)
            return ["ok": true]
        }
        TestHooks.shared.register("tango-resume") { [weak self] _ in
            self?.list?.paused()
            TangoFixtureHTTP.lock.withLock { TangoFixtureHTTP.mode = "success" }
            self?.list?.resumed(afterBackground: true)
            return ["ok": true]
        }
        TestHooks.shared.register("tango-fixture-counts") { _ in
            TangoFixtureHTTP.lock.withLock { ["requests": TangoFixtureHTTP.requests, "recoveries": TangoFixtureHTTP.recoveries] }
        }
    }
    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); list?.view.frame = view.bounds }

    private func fixture(_ mode: String) -> [String: Any] {
        list?.paused()
        if let list { list.willMove(toParent: nil); list.view.removeFromSuperview(); list.removeFromParent() }
        list = nil
        TangoFixtureHTTP.lock.withLock { TangoFixtureHTTP.mode = mode; TangoFixtureHTTP.requests = 0; TangoFixtureHTTP.recoveries = 0 }
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("tango-network-" + UUID().uuidString)
        try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try! Data().write(to: directory.appendingPathComponent("tango-cookies-migrated"))
        let jar = CookieJar(file: directory.appendingPathComponent("cookies.json"))
        jar.set(Self.cookies(session: "original", access: mode != "challenge" && mode != "challenge-no-broker" && mode != "refresh-outage"))
        jar.flush()
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [TangoFixtureHTTP.self]
        let controller = TangoListController(directory: directory, configuration: config, loginRecovery: {
            TangoFixtureHTTP.lock.withLock { TangoFixtureHTTP.recoveries += 1 }
            if mode == "challenge-no-broker" { throw TangoError.verificationRequired }
            return Self.cookies(session: "recovered", access: true)
        }, pcLoginEnabled: false)
        addChild(controller); controller.view.frame = view.bounds; view.addSubview(controller.view); controller.didMove(toParent: self)
        list = controller
        return ["mode": mode]
    }

    nonisolated private static func cookies(session: String, access: Bool) -> [HTTPCookie] {
        let payload = try! JSONSerialization.data(withJSONObject: ["accountId": "fixture-account", "sessionId": session]).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        func cookie(_ name: String, _ value: String) -> HTTPCookie {
            HTTPCookie(properties: [.name: name, .value: value, .domain: "gateway.tango.me", .path: "/", .secure: "TRUE", .expires: Date().addingTimeInterval(3600)])!
        }
        return [cookie("Tango-RT", "header." + payload + ".signature")] + (access ? [cookie("Tango-ST", "fixture-access")] : [])
    }
}
#endif
