import Foundation

final class RenameProtocolState: @unchecked Sendable {
    let lock = NSLock()
    var requests: [URLRequest] = []
    var filename = "original.mp4"
    var loseAcknowledgement = true
    var conflict = false
    func reset(conflict: Bool) { lock.withLock { requests = []; filename = "original.mp4"; loseAcknowledgement = true; self.conflict = conflict } }
    func methods() -> [String] { lock.withLock { requests.map { $0.httpMethod ?? "GET" } } }
}

final class RenameProtocol: URLProtocol, @unchecked Sendable {
    static let state = RenameProtocolState()
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "pc.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let result: (Int, String, Bool) = Self.state.lock.withLock {
            Self.state.requests.append(request)
            if request.httpMethod == "POST" {
                if Self.state.conflict { return (409, Self.state.filename, false) }
                Self.state.filename = "Renamed.mp4"
                if Self.state.loseAcknowledgement { Self.state.loseAcknowledgement = false; return (0, Self.state.filename, true) }
            }
            return (200, Self.state.filename, false)
        }
        if result.2 { client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost)); return }
        let json: [String: Any] = result.0 == 409 ? ["error": "A file with that name already exists"] : [
            "video": ["filename": result.1, "fileId": String(repeating: "a", count: 24), "type": "original", "size": 100, "duration": 20, "isLive": false],
            "epoch": "fixture", "revision": 6,
        ]
        let response = HTTPURLResponse(url: request.url!, statusCode: result.0, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: json)); client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}

@main
struct LocalRenameClientTests {
    static func main() async throws {
        let configuration = URLSessionConfiguration.ephemeral; configuration.protocolClasses = [RenameProtocol.self]
        let session = URLSession(configuration: configuration); defer { session.invalidateAndCancel() }
        let api = LocalAPI(server: URL(string: "https://pc.test:9998/videos/bunkr")!, provider: "bunkr", mediaKind: .mp4, session: session)
        let video = ServerVideo(filename: "original.mp4", type: "original", size: 100, duration: 20, isLive: false, fileId: String(repeating: "a", count: 24))
        RenameProtocol.state.reset(conflict: false)
        let result = try await api.rename(video, to: "Renamed")
        guard result.video.filename == "Renamed.mp4", RenameProtocol.state.methods() == ["POST", "GET"] else { fatalError("lost acknowledgement must be confirmed by a read, without duplicate mutation") }
        RenameProtocol.state.reset(conflict: true)
        do { _ = try await api.rename(video, to: "Renamed"); fatalError("a different file cannot be overwritten") }
        catch { guard error.localizedDescription.contains("already exists") else { throw error } }
        guard RenameProtocol.state.methods() == ["POST", "GET"] else { fatalError("conflict recovery cannot repeat the write") }
        print("PASS: lost rename acknowledgements use lookup; conflicts preserve the original and never repeat POST")
    }
}
