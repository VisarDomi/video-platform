import Foundation

// Saves state off the main thread, newest first: a screen saves on every settled scroll or
// swipe, and encoding a long list (thousands of rows) takes long enough to stutter the
// gesture that saved it. Only the newest pending value is written; `flush()` waits for it
// (before the app may be suspended); `clear()` removes the file after any pending write.
public final class BackgroundWriter: @unchecked Sendable {
    public let url: URL
    private let queue: DispatchQueue
    private let lock = NSLock()
    private var pending: (@Sendable () throws -> Data)?

    public init(url: URL, label: String = "kit-writer") {
        self.url = url
        queue = DispatchQueue(label: label, qos: .utility)
    }

    // `encode` runs on the writer's queue; capture immutable values only.
    public func save(_ encode: @escaping @Sendable () throws -> Data) {
        lock.withLock { pending = encode }
        queue.async { self.write() }
    }

    public func save<T: Encodable & Sendable>(json value: T) {
        save {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            return try encoder.encode(value)
        }
    }

    public func clear() {
        lock.withLock { pending = nil }
        queue.async { try? FileManager.default.removeItem(at: self.url) }
    }

    public func flush() { queue.sync {} }

    private func write() {
        guard let encode = lock.withLock({ () -> (@Sendable () throws -> Data)? in
            defer { pending = nil }
            return pending
        }) else { return }
        do { try DurableFile.write(encode(), to: url) }
        catch { Log.store.error("Could not save \(self.url.lastPathComponent, privacy: .public): \(error.localizedDescription, privacy: .public)") }
    }
}
