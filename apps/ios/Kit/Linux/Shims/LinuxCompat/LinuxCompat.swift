// Linux (logic tests on the PC): Darwin Foundation API the apps' logic uses that corelibs lacks.
// Imported implicitly by the test compiles (swift-env.sh), with FoundationNetworking.
@_exported import Foundation
@_exported import FoundationNetworking

extension URLSessionTask {
    public static let highPriority: Float = 0.75
    public static let lowPriority: Float = 0.25
}

extension URLSession {
    public var allTasks: [URLSessionTask] {
        get async { await withCheckedContinuation { continuation in getAllTasks { continuation.resume(returning: $0) } } }
    }
}

// corelibs' own async URLSession methods deadlock when concurrent requests are cancelled (8 refused
// requests + TaskGroup.cancelAll never return; Swift 6.2.4). These overloads, preferred because
// they need no default argument, use the completion-handler tasks, which cancel correctly.
private final class TaskBox: @unchecked Sendable {
    private let lock = NSLock(); private var task: URLSessionTask?; private var cancelled = false
    func set(_ task: URLSessionTask) { let cancel = lock.withLock { self.task = task; return cancelled }; if cancel { task.cancel() } }
    func cancel() { let task = lock.withLock { cancelled = true; return self.task }; task?.cancel() }
}

extension URLSession {
    public func data(from url: URL) async throws -> (Data, URLResponse) { try await data(for: URLRequest(url: url)) }
    public func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let box = TaskBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let task = dataTask(with: request) { data, response, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let data, let response { continuation.resume(returning: (data, response)) }
                    else { continuation.resume(throwing: URLError(.badServerResponse)) }
                }
                box.set(task); task.resume()
            }
        } onCancel: { box.cancel() }
    }
    public func download(from url: URL) async throws -> (URL, URLResponse) { try await download(for: URLRequest(url: url)) }
    public func download(for request: URLRequest) async throws -> (URL, URLResponse) {
        let box = TaskBox()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let task = downloadTask(with: request) { location, response, error in
                    if let error { continuation.resume(throwing: error); return }
                    guard let location, let response else { continuation.resume(throwing: URLError(.badServerResponse)); return }
                    // The handler's file is deleted when it returns: keep it, as the async API does.
                    let kept = FileManager.default.temporaryDirectory.appendingPathComponent("CFNetworkDownload_" + UUID().uuidString + ".tmp")
                    do { try FileManager.default.moveItem(at: location, to: kept); continuation.resume(returning: (kept, response)) }
                    catch { continuation.resume(throwing: error) }
                }
                box.set(task); task.resume()
            }
        } onCancel: { box.cancel() }
    }
}
