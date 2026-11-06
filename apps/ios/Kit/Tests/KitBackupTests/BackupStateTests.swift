import Foundation
import XCTest
@testable import KitBackup

private final class BackupProtocol: URLProtocol, @unchecked Sendable {
    static let lock = NSLock()
    nonisolated(unsafe) static var pending: [BackupProtocol] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.lock.withLock { Self.pending.append(self) } }
    override func stopLoading() {}
    static func take() -> BackupProtocol? { lock.withLock { pending.isEmpty ? nil : pending.removeFirst() } }
    func answer(status: Int) {
        let id = request.url!.lastPathComponent
        let body = Data("{\"id\":\"\(id)\",\"current\":{\"revision\":\"new-revision\"}}".utf8)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: [:])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body); client?.urlProtocolDidFinishLoading(self)
    }
}

final class BackupStateTests: XCTestCase {
    @MainActor func testOldAcknowledgementAndConflictCannotReplaceANewIdentity() async throws {
        for status in [200, 409] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let backup = PCBackup(scope: "test", base: URL(string: "https://backup.test")!, key: "fixture", trust: nil,
                                  directory: root, capture: { ["ids": [1]] }, restore: { _ in }, stats: { _ in "1" },
                                  configure: { $0.protocolClasses = [BackupProtocol.self] })
            backup.identity = BackupIdentity(id: "old", label: "Old", revision: "before")
            let saving = Task { try await backup.save() }
            var request: BackupProtocol?
            for _ in 0..<200 {
                request = BackupProtocol.take()
                if request != nil { break }
                try await Task.sleep(for: .milliseconds(5))
            }
            XCTAssertNotNil(request)
            backup.identity = BackupIdentity(id: "new", label: "New", revision: nil)
            request?.answer(status: status)
            _ = try await saving.value
            XCTAssertEqual(backup.identity?.id, "new")
        }
    }
}
