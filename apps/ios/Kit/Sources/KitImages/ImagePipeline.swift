import Foundation
import ImageIO
import KitCore
#if canImport(UIKit)
import UIKit

// Where an image's bytes are: a local file, or a loader that produces one (a store that
// reads or first downloads it, a disk cache that fetches it).
public enum ImageSource: Sendable {
    case file(URL)
    case load(@Sendable () async throws -> URL)
}

// The size to decode to, in pixels: a width (pages, the height follows the image), a box the
// image must cover (cropped thumbnails), or a longest side.
public enum ImageFit: Sendable, Hashable {
    case width(Int)
    case cover(width: Int, height: Int)
    case maxPixel(Int)
}

public struct ImageTicket: Sendable {
    let id: UInt64
    weak var pipeline: ImagePipeline?
    @MainActor public func cancel() { pipeline?.cancel(self) }
}

// What WebKit did for the pages: decode at display size (ImageIO downsampling, so a tall page
// or a thousand thumbnails never hold full bitmaps), off the main thread, a few at a time,
// always the most urgent next (the caller's priority: distance from the screen, re-asked
// as scrolling moves), with decoded images kept in a bounded memory cache. Requests for
// the same image share one decode.
@MainActor
public final class ImagePipeline {
    public struct Request {
        public let key: String
        public let source: ImageSource
        public let fit: ImageFit
        public let priority: () -> Double
        // The image's file when it is already on the phone (see beginRestore).
        public let localFile: URL?
        public init(key: String, source: ImageSource, fit: ImageFit, localFile: URL? = nil, priority: @escaping () -> Double) {
            self.key = key
            self.source = source
            self.fit = fit
            self.localFile = localFile
            self.priority = priority
        }
    }

    private final class Pending {
        let request: Request
        var completions: [UInt64: (Result<UIImage, Error>) -> Void] = [:]
        var task: Task<Void, Never>?
        var ahead = false
        init(_ request: Request) { self.request = request }
    }

    private let cache = NSCache<NSString, UIImage>()
    private let concurrency: Int
    private var pending: [String: Pending] = [:]
    private var queue: [String] = []
    private var queueStale = true
    private var sortedAt: CFTimeInterval = 0
    private var running = 0
    // Images off the screen (decoded ahead) at most this many at once, at a lower priority: big
    // pages decoding ahead must not take the cores the screen and its compositor need. Those on
    // the screen always go first, as many at once as `concurrency` allows.
    public var aheadConcurrency = 2
    private var runningAhead = 0
    private var nextID: UInt64 = 0
    private var ticketKeys: [UInt64: String] = [:]
    private var restoreBudget: CFTimeInterval = 0
    private var restoreLink: CADisplayLink?
    private var restoreFrames = 0
    private var restoreEnds: CFTimeInterval = 0
    public private(set) var restoredNow = 0
    // Within a relaunch's first frames (screens may read what they show from disk at once then;
    // afterwards they ask in the background).
    public var isRestoring: Bool { restoreBudget > 0 }

    public init(memoryLimit: Int = 192 << 20, concurrency: Int = 4) {
        cache.totalCostLimit = memoryLimit
        self.concurrency = concurrency
    }

    // Whenever the screen's geometry changes the priorities (a scroll moved).
    public func prioritiesChanged() { queueStale = true }

    // A relaunch restoring the screens as they were left: until a few frames have been shown,
    // an image whose file is already on the phone (Request.localFile) is decoded at once on
    // the main thread, so the first frame has it instead of an empty box filled moments later.
    // `budget` bounds the time spent so (beyond it, decoding is off the main thread as always).
    // The frames are counted once the screen is up (a slow launch can take several before its
    // first layout); at most `timeout` seconds in all.
    public func beginRestore(budget: CFTimeInterval = 1.5, frames: Int = 4, timeout: CFTimeInterval = 3) {
        restoreBudget = budget
        restoreFrames = frames
        restoreEnds = CACurrentMediaTime() + timeout
        let link = CADisplayLink(target: RestoreTicker { [weak self] in self?.restoreTick() }, selector: #selector(RestoreTicker.fire))
        link.add(to: .main, forMode: .common)
        restoreLink = link
    }

    private func restoreTick() {
        let shown = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
            .contains { $0.isKeyWindow && $0.rootViewController?.viewIfLoaded?.window != nil }
        if shown { restoreFrames -= 1 }
        guard restoreFrames <= 0 || CACurrentMediaTime() > restoreEnds else { return }
        restoreBudget = 0
        restoreLink?.invalidate()
        restoreLink = nil
    }

    private func restoreNow(_ request: Request) -> UIImage? {
        guard restoreBudget > 0, let file = request.localFile else { return nil }
        let start = CACurrentMediaTime()
        defer { restoreBudget -= CACurrentMediaTime() - start }
        guard let image = try? Self.decodeNow(file, fit: request.fit) else { return nil }
        restoredNow += 1
        cache.setObject(image, forKey: Self.cacheKey(request.key, request.fit), cost: Self.cost(image))
        return image
    }

    public func cached(_ key: String, fit: ImageFit) -> UIImage? { cache.object(forKey: Self.cacheKey(key, fit)) }

    @discardableResult
    public func load(_ request: Request, completion: @escaping (Result<UIImage, Error>) -> Void) -> ImageTicket {
        nextID += 1
        let ticket = ImageTicket(id: nextID, pipeline: self)
        if let image = cached(request.key, fit: request.fit) ?? restoreNow(request) {
            completion(.success(image))
            return ticket
        }
        let key = Self.cacheKey(request.key, request.fit) as String
        let entry = pending[key] ?? {
            let entry = Pending(request)
            pending[key] = entry
            queue.append(key)
            queueStale = true
            return entry
        }()
        entry.completions[ticket.id] = completion
        ticketKeys[ticket.id] = key
        pump()
        return ticket
    }

    func cancel(_ ticket: ImageTicket) {
        guard let key = ticketKeys.removeValue(forKey: ticket.id), let entry = pending[key] else { return }
        entry.completions[ticket.id] = nil
        guard entry.completions.isEmpty else { return }
        entry.task?.cancel()
        pending[key] = nil
    }

    public var state: [String: Any] { ["pending": pending.count, "running": running, "cacheLimit": cache.totalCostLimit, "restoredNow": restoredNow] }

    private func pump() {
        while running < concurrency {
            if queueStale && (queue.isEmpty || CACurrentMediaTime() - sortedAt > 0.1) { sortQueue() }
            guard let key = queue.last else { return }
            guard let entry = pending[key], entry.task == nil else { queue.removeLast(); continue }
            // The queue is nearest first: once the next is off the screen, so is the rest.
            let ahead = entry.request.priority() > 0
            if ahead && runningAhead >= aheadConcurrency { return }
            queue.removeLast()
            running += 1
            if ahead { runningAhead += 1 }
            entry.ahead = ahead
            let request = entry.request
            let priority: TaskPriority = ahead ? .utility : .userInitiated
            entry.task = Task(priority: priority) { [weak self] in
                let result: Result<UIImage, Error>
                do {
                    let file: URL
                    switch request.source {
                    case .file(let url): file = url
                    case .load(let loader): file = try await loader()
                    }
                    try Task.checkCancellation()
                    result = .success(try await Self.decode(file, fit: request.fit, priority: priority))
                } catch { result = .failure(error) }
                self?.finish(key, entry: entry, result: result)
            }
        }
    }

    private func finish(_ key: String, entry: Pending, result: Result<UIImage, Error>) {
        running -= 1
        if entry.ahead { runningAhead -= 1 }
        if pending[key] === entry { pending[key] = nil }
        if case .success(let image) = result {
            cache.setObject(image, forKey: key as NSString, cost: Self.cost(image))
        }
        FrameMonitor.shared.measure("images.deliver") {
            for (id, completion) in entry.completions {
                ticketKeys[id] = nil
                if !(entry.task?.isCancelled ?? false) { completion(result) }
            }
        }
        pump()
    }

    // The nearest (lowest priority value) last, so popLast takes it.
    private func sortQueue() {
        queue = pending.filter { $0.value.task == nil }
            .map { (key: $0.key, priority: $0.value.request.priority()) }
            .sorted { $0.priority > $1.priority }
            .map(\.key)
        queueStale = false
        sortedAt = CACurrentMediaTime()
    }

    nonisolated static func cacheKey(_ key: String, _ fit: ImageFit) -> NSString { "\(fit)|\(key)" as NSString }

    nonisolated static func cost(_ image: UIImage) -> Int { Int(image.size.width * image.size.height * image.scale * image.scale * 4) }

    // A decoded image stays under this many pixels (64 MB): an extreme strip decodes softer
    // rather than taking the memory of a dozen pages.
    nonisolated static let pixelBudget = 16_000_000

    // Downsampled and fully decoded off the main thread; the original's orientation applied.
    nonisolated public static func decode(_ file: URL, fit: ImageFit, priority: TaskPriority = .userInitiated) async throws -> UIImage {
        try await Task.detached(priority: priority) { try decodeNow(file, fit: fit) }.value
    }

    // The same, on the calling thread.
    nonisolated public static func decodeNow(_ file: URL, fit: ImageFit) throws -> UIImage {
        guard let source = CGImageSourceCreateWithURL(file as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else {
            throw ImageError.unreadable(file)
        }
        let size = pixelSize(source) ?? CGSize(width: 1, height: 1)
        let longest = max(size.width, size.height, 1)
        var scale: CGFloat
        switch fit {
        case .width(let width): scale = CGFloat(width) / max(size.width, 1)
        case .cover(let width, let height): scale = max(CGFloat(width) / max(size.width, 1), CGFloat(height) / max(size.height, 1))
        case .maxPixel(let pixels): scale = CGFloat(pixels) / longest
        }
        scale = min(scale, 1, sqrt(CGFloat(pixelBudget) / max(size.width * size.height, 1)))
        let maxPixel = max(1, Int((longest * scale).rounded(.up)))
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixel),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { throw ImageError.unreadable(file) }
        return UIImage(cgImage: image)
    }

    // The image's pixel size without decoding it (orientation applied).
    nonisolated public static func pixelSize(_ file: URL) -> CGSize? {
        CGImageSourceCreateWithURL(file as CFURL, nil).flatMap(pixelSize)
    }

    nonisolated static func pixelSize(_ source: CGImageSource) -> CGSize? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? CGFloat,
              let height = properties[kCGImagePropertyPixelHeight] as? CGFloat else { return nil }
        let orientation = properties[kCGImagePropertyOrientation] as? UInt32 ?? 1
        return orientation >= 5 ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
    }
}
#endif

#if canImport(UIKit)
private final class RestoreTicker: NSObject {
    let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func fire() { action() }
}
#endif

public enum ImageError: LocalizedError {
    case unreadable(URL)
    public var errorDescription: String? {
        switch self { case .unreadable(let url): "The image \(url.lastPathComponent) could not be decoded." }
    }
}
