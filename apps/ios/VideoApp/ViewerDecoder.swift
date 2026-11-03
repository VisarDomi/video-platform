import UIKit

// Alternate decoding stays behind the same unit/surface, timeline and gestures.
// It receives the original URL; it never asks the server to transform media.
@MainActor
protocol ViewerDecoder: AnyObject {
    var currentTime: Double { get }
    var duration: Double { get }
    var size: CGSize { get }
    var playing: Bool { get }
    var hasPicture: Bool { get }
    var reachedEnd: Bool { get }
    var evidence: [String: Any] { get }
    var muted: Bool { get set }
    func play()
    func pause()
    func seek(_ seconds: Double)
    func setVideoEnabled(_ enabled: Bool)
    func stop()
}

@MainActor
enum ViewerDecoders {
    static var available: Bool {
        #if canImport(VLCKit)
        true
        #else
        false
        #endif
    }

    static func make(source: MediaSource, video: ViewerVideo, surface: UIView, start: Double,
                     changed: @escaping () -> Void, failed: @escaping () -> Void) async -> (any ViewerDecoder)? {
        guard !Task.isCancelled else { return nil }
        #if canImport(AetherEngine)
        #if ORIGINAL_CODEC_PROBE
        let requiresHardware = false  // Exercise lifecycle even on CPU-only simulator runtimes.
        #else
        let requiresHardware = true
        #endif
        // First migration step: VP9 can use Apple's supplemental hardware decoder.
        // Keep the established paths for other codecs until their own measurements pass.
        if (video.raw["videoCodec"] as? String)?.lowercased() == "vp9",
           let decoder = await FFmpegVideoDecoder.create(source: source, video: video, surface: surface, start: start, changed: changed, failed: failed, requiresHardware: requiresHardware) {
            return decoder
        }
        #endif
        guard !Task.isCancelled else { return nil }
        #if canImport(VLCKit)
        return await VLCVideoDecoder.create(source: source, video: video, surface: surface, start: start, changed: changed, failed: failed)
        #else
        return nil
        #endif
    }
}
