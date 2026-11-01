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
        #if canImport(VLCKit)
        return await VLCVideoDecoder.create(source: source, video: video, surface: surface, start: start, changed: changed, failed: failed)
        #else
        return nil
        #endif
    }
}
