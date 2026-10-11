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
        public init(key: String, source: ImageSource, fit: ImageFit, priority: @escaping () -> Double) {
            self.key = key
            self.source = source
            self.fit = fit
            self.priority = priority
        }
    }

    private final class Pending {
        let request: Request
        var completions: [UInt64: (Result<UIImage, Error>) -> Void] = [:]
        var task: Task<Void, Never>?
        init(_ request: Request) { self.request = request }
    }

    private let cache = NSCache<NSString, UIImage>()
    private let concurrency: Int
    private var pending: [String: Pending] = [:]
    private var queue: [String] = []
    private var queueStale = true
    private var sortedAt: CFTimeInterval = 0
    private var running = 0
    private var nextID: UInt64 = 0
    private var ticketKeys: [UInt64: String] = [:]

    public init(memoryLimit: Int = 192 << 20, concurrency: Int = 4) {
        cache.totalCostLimit = memoryLimit
        self.concurrency = concurrency
    }

    // Whenever the screen's geometry changes the priorities (a scroll moved).
    public func prioritiesChanged() { queueStale = true }

    public func cached(_ key: String, fit: ImageFit) -> UIImage? { cache.object(forKey: Self.cacheKey(key, fit)) }

    @discardableResult
    public func load(_ request: Request, completion: @escaping (Result<UIImage, Error>) -> Void) -> ImageTicket {
        nextID += 1
        let ticket = ImageTicket(id: nextID, pipeline: self)
        if let image = cached(request.key, fit: request.fit) {
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

    public var state: [String: Any] { ["pending": pending.count, "running": running, "cacheLimit": cache.totalCostLimit] }

    private func pump() {
        while running < concurrency {
            if queueStale && (queue.isEmpty || CACurrentMediaTime() - sortedAt > 0.1) { sortQueue() }
            guard let key = queue.popLast() else { return }
            guard let entry = pending[key], entry.task == nil else { continue }
            running += 1
            let request = entry.request
            entry.task = Task { [weak self] in
                let result: Result<UIImage, Error>
                do {
                    let file: URL
                    switch request.source {
                    case .file(let url): file = url
                    case .load(let loader): file = try await loader()
                    }
                    try Task.checkCancellation()
                    result = .success(try await Self.decode(file, fit: request.fit))
                } catch { result = .failure(error) }
                self?.finish(key, entry: entry, result: result)
            }
        }
    }

    private func finish(_ key: String, entry: Pending, result: Result<UIImage, Error>) {
        running -= 1
        if pending[key] === entry { pending[key] = nil }
        if case .success(let image) = result {
            cache.setObject(image, forKey: key as NSString, cost: Int(image.size.width * image.size.height * image.scale * image.scale * 4))
        }
        for (id, completion) in entry.completions {
            ticketKeys[id] = nil
            if !(entry.task?.isCancelled ?? false) { completion(result) }
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

    // A decoded image stays under this many pixels (64 MB): an extreme strip decodes softer
    // rather than taking the memory of a dozen pages.
    nonisolated static let pixelBudget = 16_000_000

    // Downsampled and fully decoded off the main thread; the original's orientation applied.
    nonisolated public static func decode(_ file: URL, fit: ImageFit) async throws -> UIImage {
        try await Task.detached(priority: .userInitiated) {
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
        }.value
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

public enum ImageError: LocalizedError {
    case unreadable(URL)
    public var errorDescription: String? {
        switch self { case .unreadable(let url): "The image \(url.lastPathComponent) could not be decoded." }
    }
}
