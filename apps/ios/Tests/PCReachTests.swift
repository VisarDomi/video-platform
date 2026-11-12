import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// A scripted transport for the PC's two addresses: each host answers with a status or fails
// like a network would. It records what was asked, with the gateway key it carried.
final class ListStub: URLProtocol, @unchecked Sendable {
    enum Answer { case status(Int), failure(URLError.Code) }
    static let lock = NSLock()
    nonisolated(unsafe) static var answers: [String: Answer] = [:]
    nonisolated(unsafe) static var seen: [String] = []

    static func script(_ answers: [String: Answer]) { lock.withLock { self.answers = answers; seen = [] } }
    static func asked() -> [String] { lock.withLock { seen } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!, method = request.httpMethod ?? "GET"
        let answer = Self.lock.withLock { () -> Answer? in
            let key = request.value(forHTTPHeaderField: "X-PC-Apps-Key").map { " key=" + $0 } ?? ""
            Self.seen.append(method + " " + url.absoluteString + key)
            return Self.answers[url.host! + " " + method] ?? Self.answers[url.host!]
        }
        switch answer {
        case .status(let status):
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [:])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("{}".utf8))
            client?.urlProtocolDidFinishLoading(self)
        case .failure(let code): client?.urlProtocol(self, didFailWithError: URLError(code))
        case nil: client?.urlProtocol(self, didFailWithError: URLError(.cannotFindHost))
        }
    }
    override func stopLoading() {}
}

final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_800_000_000)
    var now: Date { lock.withLock { date } }
    func advance(_ seconds: TimeInterval) { lock.withLock { date += seconds } }
}

func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { print("FAIL: " + message); exit(1) }
}

// The PC's download lists from anywhere (PCReach): home first, the public address only when
// home does not answer, 45 s without home after that, a status final, a write sent once.
@main
struct PCReachTests {
    static let home = "192.168.1.197", away = "pc.example.test"
    static let member = "GET https://192.168.1.197:9999/api/tango/member?identifier=a%20b"
    static let memberAway = "GET https://pc.example.test/video/api/tango/member?identifier=a%20b key=fixture"
    static let add = "POST https://192.168.1.197:9999/api/tango/add"
    static let addAway = "POST https://pc.example.test/video/api/tango/add key=fixture"

    static func reach(_ clock: TestClock, key: String? = "fixture") -> PCReach {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ListStub.self]
        return PCReach(home: URL(string: "https://192.168.1.197:9999")!, away: URL(string: "https://pc.example.test/video")!, key: key,
                       session: URLSession(configuration: configuration), now: { clock.now })
    }

    static func main() async throws {
        let query = ["identifier": "a b"], body = Data(#"{"identifier":"a b"}"#.utf8)

        // Home answers: one request, no key.
        var clock = TestClock(), pc = reach(clock)
        ListStub.script([home: .status(200), away: .status(200)])
        var answer = try await pc.read("api/tango/member", query: query)
        expect(answer.status == 200 && answer.fromHome && ListStub.asked() == [member], "home first, alone, without the gateway key: \(ListStub.asked())")

        // A status from home is the PC's answer.
        ListStub.script([home: .status(500), away: .status(200)])
        answer = try await pc.read("api/tango/member", query: query)
        expect(answer.status == 500 && ListStub.asked() == [member], "an HTTP status from home is final: \(ListStub.asked())")

        // A transport failure at home moves a read to the public address, with the key.
        clock = TestClock(); pc = reach(clock)
        ListStub.script([home: .failure(.cannotConnectToHost), away: .status(200)])
        answer = try await pc.read("api/tango/member", query: query)
        expect(answer.status == 200 && !answer.fromHome && ListStub.asked() == [member, memberAway], "home, then public with the key: \(ListStub.asked())")

        // Home is skipped for 45 s after it failed, then tried again.
        ListStub.script([home: .status(200), away: .status(200)])
        _ = try await pc.read("api/tango/member", query: query)
        expect(ListStub.asked() == [memberAway], "within 45 s only the public address is asked: \(ListStub.asked())")
        clock.advance(46)
        ListStub.script([home: .status(200), away: .status(200)])
        _ = try await pc.read("api/tango/member", query: query)
        expect(ListStub.asked() == [member], "after 45 s home is asked again: \(ListStub.asked())")

        // A write goes once, to the address that answered the question before it.
        clock = TestClock(); pc = reach(clock)
        ListStub.script([home: .status(200), away: .status(200)])
        answer = try await pc.write("api/tango/add", json: body, probe: "api/tango/member", probeQuery: query)
        expect(answer.fromHome && ListStub.asked() == [member, add], "at home: asked, then written, both at home: \(ListStub.asked())")

        clock = TestClock(); pc = reach(clock)
        ListStub.script([home: .failure(.timedOut), away: .status(200)])
        answer = try await pc.write("api/tango/add", json: body, probe: "api/tango/member", probeQuery: query)
        expect(!answer.fromHome && ListStub.asked() == [member, memberAway, addAway], "away: the write goes to the public address only: \(ListStub.asked())")

        // A write that fails is not repeated on the other address: it may have arrived.
        clock = TestClock(); pc = reach(clock)
        ListStub.script([home + " GET": .status(200), home + " POST": .failure(.networkConnectionLost), away: .status(200)])
        do { _ = try await pc.write("api/tango/add", json: body, probe: "api/tango/member", probeQuery: query); expect(false, "a lost write must fail") }
        catch { expect(ListStub.asked() == [member, add], "a lost write is never sent again: \(ListStub.asked())") }

        // A refused question is the answer; nothing is written.
        ListStub.script([home: .status(503), away: .status(200)])
        answer = try await pc.write("api/tango/add", json: body, probe: "api/tango/member", probeQuery: query)
        expect(answer.status == 503 && ListStub.asked() == [member], "no write after a refused question: \(ListStub.asked())")

        // Without the gateway's key the PC is home-only, as before.
        pc = reach(TestClock(), key: nil)
        ListStub.script([home: .failure(.cannotConnectToHost), away: .status(200)])
        do { _ = try await pc.read("api/tango/member", query: query); expect(false, "home-only must fail when home is unreachable") }
        catch { expect(ListStub.asked() == [member], "home-only asks home alone: \(ListStub.asked())") }

        print("PASS: the PC's download lists are asked at home first, then at the public address; a write is sent once")
    }
}
