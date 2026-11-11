import AVFoundation
import CryptoKit
import UIKit
#if canImport(AetherEngine)
import AetherEngine
#endif

// A paused neighbour's picture: the keyframe its saved position opens on, read once from
// the original file without a player and kept on the phone. Neighbours show it instead of
// each holding a 4K decoder, so the video being watched has the decoder, the processor and
// the network to itself. The player later opens on the same keyframe, under the still.
@MainActor
enum NeighbourPoster {
    // Wide enough for a landscape video across a portrait screen at 3x; a full landscape
    // screen shows it only until the player's own first picture.
    private static let maxPixels: CGFloat = 1280
    private nonisolated static let limit = 240
    private static let memory: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        // The units on screen hold their own stills; this keeps the ones just scrolled past.
        cache.countLimit = 12
        return cache
    }()
    private static let files = DispatchQueue(label: "Bunkr.posters", qos: .utility)
    private static let directory: URL = {
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BunkrPosters", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()
    private static var pruned = false
    // The stills on the phone: positions (tenths of a second) by file.
    private static var known: [String: Set<Int>]?

    // One still per file and saved position: the position is what decides the keyframe, and
    // a renamed file keeps its identity.
    private static func file(_ video: ViewerVideo) -> String {
        SHA256.hash(data: Data(video.progressKey.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
    }
    private static func tenths(_ seconds: Double) -> Int { Int((max(0, seconds) * 10).rounded()) }

    // The still for this position, or the one kept within a second of it: a video scrolled
    // away from plays on until the document rests, a moment past the position that was
    // saved for it, and almost always inside the same group of pictures.
    private static func name(_ video: ViewerVideo, near seconds: Double) -> String {
        let file = file(video), wanted = tenths(seconds)
        let nearest = known?[file]?.min { abs($0 - wanted) < abs($1 - wanted) }
        return file + "-" + String(nearest.map { abs($0 - wanted) <= 10 ? $0 : wanted } ?? wanted)
    }

    static func cached(_ video: ViewerVideo, at seconds: Double) -> UIImage? {
        memory.object(forKey: name(video, near: seconds) as NSString)
    }

    // The still kept from an earlier visit, decoded off the main thread.
    static func stored(_ video: ViewerVideo, at seconds: Double) async -> UIImage? {
        if known == nil {
            let listed: [String: Set<Int>] = await withCheckedContinuation { continuation in
                let directory = directory
                files.async {
                    var found: [String: Set<Int>] = [:]
                    for url in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? [] {
                        let parts = url.deletingPathExtension().lastPathComponent.split(separator: "-")
                        if parts.count == 2, let position = Int(parts[1]) { found[String(parts[0]), default: []].insert(position) }
                    }
                    continuation.resume(returning: found)
                }
            }
            // Stills made while the folder was being listed stay known.
            known = listed.merging(known ?? [:]) { $0.union($1) }
        }
        let name = name(video, near: seconds)
        if let image = memory.object(forKey: name as NSString) { return image }
        let url = directory.appendingPathComponent(name + ".jpg")
        let image: UIImage? = await withCheckedContinuation { continuation in
            files.async {
                guard let data = try? Data(contentsOf: url), let image = UIImage(data: data) else { continuation.resume(returning: nil); return }
                // Opened recently: pruning removes the stills least recently shown.
                try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
                continuation.resume(returning: image.preparingForDisplay() ?? image)
            }
        }
        if let image { memory.setObject(image, forKey: name as NSString) }
        return image
    }

    // Reads the keyframe at or before `seconds` from the original file. Supported files use
    // the system's image generator; the others the direct decoder's keyframe extractor.
    static func make(_ video: ViewerVideo, source: MediaSource, at seconds: Double) async -> UIImage? {
        let file = file(video), position = tenths(seconds)
        let name = file + "-" + String(position)
        let picture: CGImage?
        if video.needsAlternateDecoder { picture = await keyframe(source.url, at: seconds) }
        else {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: source.url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: maxPixels, height: maxPixels)
            generator.requestedTimeToleranceBefore = .positiveInfinity
            generator.requestedTimeToleranceAfter = .zero
            picture = try? await generator.image(at: CMTime(seconds: max(0, seconds), preferredTimescale: 600)).image
        }
        guard let picture else { return nil }
        let image = UIImage(cgImage: picture)
        memory.setObject(image, forKey: name as NSString)
        known = (known ?? [:]).merging([file: [position]]) { $0.union($1) }
        let url = directory.appendingPathComponent(name + ".jpg")
        let prune = !pruned
        pruned = true
        files.async {
            if let data = image.jpegData(compressionQuality: 0.82) { try? data.write(to: url, options: .atomic) }
            if prune { Self.prune() }
        }
        return image
    }

    // A video left at `seconds` opens there next time: its still is read now, in the
    // background, so that opening shows a picture at once. One at a time, in order.
    private static var keeping: Task<Void, Never>?
    static func keep(_ video: ViewerVideo, source: MediaSource, at seconds: Double) {
        guard cached(video, at: seconds) == nil else { return }
        let earlier = keeping
        keeping = Task(priority: .utility) {
            await earlier?.value
            guard await stored(video, at: seconds) == nil else { return }
            _ = await make(video, source: source, at: seconds)
        }
    }

    private static func keyframe(_ url: URL, at seconds: Double) async -> CGImage? {
        #if canImport(AetherEngine)
        let extractor = FrameExtractor(url: url)
        let image = await extractor.thumbnail(at: max(0, seconds), maxWidth: Int(maxPixels))
        await extractor.shutdown()
        return image
        #else
        return nil
        #endif
    }

    // Once per launch, off the main thread: the stills least recently shown go first.
    private nonisolated static func prune() {
        let keys: [URLResourceKey] = [.contentModificationDateKey]
        let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BunkrPosters", isDirectory: true)
        guard let stills = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys),
              stills.count > limit else { return }
        let dated = stills.map { ($0, (try? $0.resourceValues(forKeys: Set(keys)).contentModificationDate) ?? .distantPast) }
        for (url, _) in dated.sorted(by: { $0.1 < $1.1 }).prefix(stills.count - limit) { try? FileManager.default.removeItem(at: url) }
    }
}
