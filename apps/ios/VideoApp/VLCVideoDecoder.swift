#if canImport(VLCKit)
import UIKit
import VLCKit

// Plugin discovery, network/media setup and library allocation never block a gesture.
// A shared library also avoids allocating one libvlc instance per paused neighbour.
private final class VLCPreparedMedia: @unchecked Sendable {
    static let library: VLCLibrary = {
        // This official iOS binary uses Apple's Secure Transport and the existing
        // system trust store, just like the other native local players.
        return VLCLibrary(options: ["--no-video-title-show", "--network-caching=1500"])
    }()
    let player: VLCMediaPlayer
    let media: VLCMedia
    init?(url: URL, start: Double) {
        player = VLCMediaPlayer(library: Self.library)
        guard let media = VLCMedia(url: url) else { return nil }
        self.media = media
        media.addOption(":start-paused")
        if start > 0 { media.addOption(":start-time=\(start)") }
        player.media = media
    }
}

// Bunkr's original AV1 files need a decoder absent from AVFoundation on the A14.
// VLCKit supplies dav1d; supported codecs continue using the system player.
@MainActor
final class VLCVideoDecoder: NSObject, ViewerDecoder, VLCMediaPlayerDelegate {
    private let player: VLCMediaPlayer
    private let media: VLCMedia
    private var timer: Timer?
    private var requested = false
    private var opened = false
    private var stopped = false
    private var initialTime: Double
    private var lastTime: Double
    private var pendingSeek: Double?
    private var ended = false
    private let knownDuration: Double
    private let changed: () -> Void
    private let failed: () -> Void
    private var videoEnabled = true

    static func create(source: MediaSource, video: ViewerVideo, surface: UIView, start: Double,
                       changed: @escaping () -> Void, failed: @escaping () -> Void) async -> VLCVideoDecoder? {
        guard let core = await Task.detached(priority: .userInitiated, operation: { VLCPreparedMedia(url: source.url, start: start) }).value else { return nil }
        return VLCVideoDecoder(core: core, video: video, surface: surface, start: start, changed: changed, failed: failed)
    }

    private init(core: VLCPreparedMedia, video: ViewerVideo, surface: UIView, start: Double,
                 changed: @escaping () -> Void, failed: @escaping () -> Void) {
        player = core.player
        media = core.media
        initialTime = max(0, start)
        lastTime = max(0, start)
        pendingSeek = start > 0 ? start : nil
        knownDuration = (video.raw["duration"] as? NSNumber)?.doubleValue ?? 0
        self.changed = changed
        self.failed = failed
        super.init()
        player.drawable = surface
        player.videoFitMode = .smaller
        player.delegate = self
        player.audio?.isMuted = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.changed() }
        }
        // Native paused preparation, so neighbours can show a still frame during
        // scrolling without starting playback or audio.
        player.play()
    }

    var currentTime: Double {
        guard opened else { return pendingSeek ?? initialTime }
        guard player.state != .stopped && player.state != .stopping else { return lastTime }
        let time = max(0, player.time.value?.doubleValue ?? 0) / 1000
        if let pendingSeek {
            // An asynchronous seek's old clock must not overwrite durable progress.
            if abs(time - pendingSeek) > 1 { return pendingSeek }
            self.pendingSeek = nil
        }
        lastTime = time
        return time
    }
    var duration: Double { max(knownDuration, (media.length.value?.doubleValue ?? 0) / 1000) }
    var size: CGSize { player.videoSize }
    var playing: Bool { player.isPlaying && requested }
    var hasPicture: Bool { media.statistics.displayedPictures > 0 }
    var muted: Bool {
        get { player.audio?.isMuted ?? true }
        set { player.audio?.isMuted = newValue }
    }

    func play() {
        guard !ended else { return }
        requested = true
        // A terminated input must reopen through the unit's bounded recovery at
        // its saved clock. libvlc play() alone would start that input from zero.
        if opened && (player.state == .stopped || player.state == .error) { failed(); return }
        player.play()
    }
    func pause() { requested = false; player.pause() }
    func seek(_ seconds: Double) {
        initialTime = max(0, seconds)
        pendingSeek = initialTime
        ended = false
        if opened { player.time = VLCTime(number: NSNumber(value: initialTime * 1000)) }
        else { media.addOption(":start-time=\(initialTime)") }
    }

    func setVideoEnabled(_ enabled: Bool) {
        videoEnabled = enabled
        // Keep audio and the media clock running through lock/background. Removing
        // only the video track prevents background rendering without restarting it.
        if enabled { if !player.videoTracks.isEmpty { player.selectTrack(at: 0, type: .video) } }
        else { player.deselectAllVideoTracks() }
    }

    func stop() {
        stopped = true
        requested = false
        timer?.invalidate(); timer = nil
        player.delegate = nil
        player.stop()
        player.drawable = nil
    }

    // VLCKit delivers delegate notifications on its main event queue. Keep late
    // notifications from a recycled unit from changing playback intent.
    nonisolated func mediaPlayerStateChanged(_ state: VLCMediaPlayerState) {
        Task { @MainActor [weak self] in self?.stateChanged(state) }
    }

    private func stateChanged(_ state: VLCMediaPlayerState) {
        guard !stopped else { return }
        if state == .playing {
            opened = true
            if !requested { player.pause() }
            if !videoEnabled { player.deselectAllVideoTracks() }
        }
        if state == .paused {
            opened = true
            if requested { player.play() }
        }
        if state == .stopped && opened && duration > 0 && lastTime >= duration - 1 {
            ended = true
            lastTime = duration
        }
        if state == .error || (state == .stopped && opened && requested && !ended) { failed() }
        changed()
    }

    func beginDiagnostics(at url: URL) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        let logger = VLCFileLogger(fileHandle: handle)
        logger.level = .debug
        player.libraryInstance.loggers = [logger]
    }

    var evidence: [String: Any] {
        let stats = media.statistics
        return ["engine": "VLCKit", "engineVersion": player.libraryInstance.version, "codec": "original", "currentTime": currentTime,
                "duration": duration, "rate": playing ? 1 : 0, "status": player.state.rawValue,
                "width": size.width, "height": size.height, "bytesTransferred": stats.readBytes,
                "decodedVideoFrames": stats.decodedVideo, "displayedVideoFrames": stats.displayedPictures,
                "lateVideoFrames": stats.latePictures, "droppedVideoFrames": stats.lostPictures]
    }
}
#endif
