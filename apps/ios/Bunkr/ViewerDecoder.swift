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
    // Pictures handed to the screen so far: a seek or a start is visible once this moves.
    var frameSerial: Int { get }
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
        let codec = (video.videoCodec)?.lowercased()
        #if ORIGINAL_CODEC_PROBE
        let requiresHardware = false  // Exercise lifecycle even on CPU-only simulator runtimes.
        let direct = (codec == "vp9" || codec == "av1") && !CommandLine.arguments.contains("-force-vlc")
        #elseif targetEnvironment(simulator)
        // The virtual iPhone has no hardware decoder session. It still takes the engine the
        // phone takes, so what is measured there is the phone's own path.
        let requiresHardware = false
        let direct = codec == "vp9" || codec == "av1"
        #else
        let requiresHardware = codec == "vp9"
        let direct = codec == "vp9" || codec == "av1"
        #endif
        // VP9 requires Apple's supplemental hardware decoder. AV1 uses the direct
        // sample-buffer path with dav1d where hardware decoding is unavailable.
        // Unsupported inputs retain the established fallback below.
        if direct,
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
