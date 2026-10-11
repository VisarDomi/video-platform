import Foundation
import KitCore
import KitNet

// Downloads that carry on while the app is away (locked, in the background, or closed by iOS;
// a force-quit stops them). When the app leaves the screen, its unfinished files go to a
// background URLSession, which iOS runs outside the app; each file is committed exactly as
// the app commits it (size and type checked, atomic rename). Back on screen the remaining
// transfers are cancelled and the app's own downloads carry on. Hand over while the app is
// still active: iOS defers transfers started from the background at its discretion.
public final class BackgroundTransfers: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    public struct Item: Sendable, Codable {
        public var url: URL
        public var headers: [String: String]
        // Relative to the transfers' root folder.
        public var file: String
        public var expectedSize: Int64?
        public init(url: URL, headers: [String: String] = [:], file: String, expectedSize: Int64? = nil) {
            self.url = url
            self.headers = headers
            self.file = file
            self.expectedSize = expectedSize
        }
    }

    private let root: URL
    private let trust: LocalTrust?
    private let accept: @Sendable (HTTPURLResponse) -> Bool
    private let committed: @Sendable (Item, HTTPURLResponse) -> Void
    private let lock = NSLock()
    private struct Completion: @unchecked Sendable { let call: () -> Void }
    private var finishEvents: Completion?
    private let identifier: String
    private let connections: Int
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: identifier)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.httpMaximumConnectionsPerHost = connections
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    // `identifier` must stay the same across versions (pending transfers reconnect by it).
    // `accept` checks a response before its file is committed (status, type); `committed`
    // runs after each commit (e.g. writing a type marker).
    public init(identifier: String, root: URL, trust: LocalTrust? = nil, connections: Int = 4,
                accept: @escaping @Sendable (HTTPURLResponse) -> Bool = { $0.statusCode == 200 },
                committed: @escaping @Sendable (Item, HTTPURLResponse) -> Void = { _, _ in }) {
        self.identifier = identifier
        self.root = root
        self.trust = trust
        self.connections = connections
        self.accept = accept
        self.committed = committed
        super.init()
        _ = session // Reconnects to transfers that ran while the app was closed.
    }

    // iOS relaunched the app to deliver finished transfers; it waits for this handler.
    public func handleEvents(_ completion: @escaping () -> Void) {
        lock.withLock { finishEvents = Completion(call: completion) }
        _ = session
    }

    public func handOff(_ items: [Item]) async {
        let running = Set(await session.allTasks.compactMap { $0.taskDescription.flatMap(Self.decode)?.file })
        for item in items where !running.contains(item.file) && Self.safe(item.file) {
            var request = URLRequest(url: item.url)
            for (name, value) in item.headers { request.setValue(value, forHTTPHeaderField: name) }
            let task = session.downloadTask(with: request)
            task.taskDescription = Self.encode(item)
            task.resume()
        }
    }

    public func reclaim() async {
        for task in await session.allTasks { task.cancel() }
    }

    public func pendingCount() async -> Int { await session.allTasks.count }

    static func safe(_ file: String) -> Bool { !file.hasPrefix("/") && !file.split(separator: "/").contains("..") && !file.isEmpty }

    static func encode(_ item: Item) -> String? {
        (try? JSONEncoder().encode(item)).map { String(decoding: $0, as: UTF8.self) }
    }

    static func decode(_ description: String) -> Item? {
        guard let item = try? JSONDecoder().decode(Item.self, from: Data(description.utf8)), safe(item.file) else { return nil }
        return item
    }

    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if let answer = trust?.evaluate(challenge) { completionHandler(answer.0, answer.1) }
        else { completionHandler(.performDefaultHandling, nil) }
    }

    public func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let item = downloadTask.taskDescription.flatMap(Self.decode),
              let response = downloadTask.response as? HTTPURLResponse, accept(response) else { return }
        do {
            try DurableFile.commit(location, to: root.appendingPathComponent(item.file), expectedSize: item.expectedSize)
            committed(item, response)
        } catch { Log.network.error("Background file \(item.file, privacy: .public): \(error.localizedDescription, privacy: .public)") }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error as? URLError, error.code != .cancelled {
            Log.network.error("Background transfer failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let completion = lock.withLock { () -> Completion? in
            defer { finishEvents = nil }
            return finishEvents
        }
        if let completion { DispatchQueue.main.async { completion.call() } }
    }
}
