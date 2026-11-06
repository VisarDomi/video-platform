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
    init?(url: URL, start: Double, demux: String? = nil) {
        player = VLCMediaPlayer(library: Self.library)
        guard let media = VLCMedia(url: url) else { return nil }
        self.media = media
        // VLC's native MP4 preroll path resets dav1d repeatedly on paused AV1 seeks.
        // FFmpeg's container parser seeks the same original bytes without that reset.
        media.addOption(":demux=\(demux ?? "avformat")")
        media.addOption(":start-paused")
        // Do not use start-time: libvlc then exposes a zero-based playback range,
        // which would make saved positions and later seeks use different clocks.
        player.media = media
    }
}

// Original inputs not accepted by the direct backend retain this decoder fallback.
// AVFoundation-compatible sources continue using the system player.
@MainActor
final class VLCVideoDecoder: NSObject, ViewerDecoder, VLCMediaPlayerDelegate {
    // libvlc stop is asynchronous, but releasing its player before the stopped
    // event waits for teardown. Keep that lifetime off the viewer's close/reuse
    // path, while the native output finishes using its original surface.
    private static var retiring: [UUID: VLCVideoDecoder] = [:]
    static var retiringCount: Int { retiring.count }
    private var retirement: UUID?
    private let player: VLCMediaPlayer
    private let media: VLCMedia
    private var timer: Timer?
    private var lifecycle = DecoderLifecycle()
    private var requested: Bool { lifecycle.requested }
    private var opened: Bool { lifecycle.opened }
    private var stopped: Bool { lifecycle.stopping }
    private var initialTime: Double
    private var lastTime: Double
    private var seekState = ChasingSeek()
    private var pendingSeek: Double? { seekState.target }
    private var seekInFlight: Bool { seekState.isInFlight }
    private var ended: Bool { lifecycle.terminal }
    private var inputFailed: Bool { lifecycle.failed }
    private let knownDuration: Double
    private let changed: () -> Void
    private let failed: () -> Void
    private var output = VideoOutputState.enabled
    private var videoEnabled: Bool { output.requested }
    private var videoRestorePending: Bool { output.needsRestore }
    private var stateEvents: [[String: Any]] = []
    private let surface: UIView
    private var firstPictureAfterSeek: UInt64?
    private var steppedPicture = false
    private var frameStepInFlight = false
    private var frameStepAttempts = 0
    private var frameStepEvents: [[String: Any]] = []

    static func create(source: MediaSource, video: ViewerVideo, surface: UIView, start: Double,
                       changed: @escaping () -> Void, failed: @escaping () -> Void, demux: String? = nil) async -> VLCVideoDecoder? {
        guard let core = await Task.detached(priority: .userInitiated, operation: { VLCPreparedMedia(url: source.url, start: start, demux: demux) }).value else { return nil }
        return VLCVideoDecoder(core: core, video: video, surface: surface, start: start, changed: changed, failed: failed)
    }

    private init(core: VLCPreparedMedia, video: ViewerVideo, surface: UIView, start: Double,
                 changed: @escaping () -> Void, failed: @escaping () -> Void) {
        player = core.player
        media = core.media
        initialTime = max(0, start)
        lastTime = max(0, start)
        var initialSeek = ChasingSeek()
        initialSeek.request(max(0, start))
        seekState = initialSeek
        knownDuration = (video.raw["duration"] as? NSNumber)?.doubleValue ?? 0
        self.changed = changed
        self.failed = failed
        self.surface = surface
        super.init()
        player.minimalTimePeriod = Int64(VideoTerminalState.clockPeriod * 1_000_000)
        player.timeChangeUpdateInterval = VideoTerminalState.clockPeriod
        player.drawable = surface
        player.videoFitMode = .smaller
        player.delegate = self
        player.audio?.isMuted = true
        surface.isHidden = start > 0
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.restoreVideoIfReady()
                self.applyPendingSeek()
                self.preparePausedPicture()
                if let before = self.firstPictureAfterSeek, self.media.statistics.displayedPictures > before, self.pendingSeek == nil {
                    self.surface.isHidden = false
                    self.firstPictureAfterSeek = nil
                }
                self.changed()
            }
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
        // Native paused preparation, so neighbours can show a still frame during
        // scrolling without starting playback or audio.
        player.play()
    }

    var currentTime: Double {
        if let pendingSeek { return pendingSeek }
        guard opened, requested else { return lastTime }
        guard player.state != .stopped && player.state != .stopping && player.state != .error else { return lastTime }
        let time = max(0, player.time.value?.doubleValue ?? 0) / 1000
        lastTime = time
        return time
    }
    var duration: Double { max(knownDuration, (media.length.value?.doubleValue ?? 0) / 1000) }
    var size: CGSize { player.videoSize }
    var playing: Bool { player.isPlaying && requested }
    var hasPicture: Bool { !surface.isHidden && (steppedPicture || media.statistics.displayedPictures > 0) }
    var reachedEnd: Bool { ended }
    var muted: Bool {
        get { player.audio?.isMuted ?? true }
        set { player.audio?.isMuted = newValue }
    }

    func play() {
        guard !ended else { return }
        if !requested, opened, pendingSeek == nil {
            let raw = max(0, player.time.value?.doubleValue ?? 0) / 1000
            if abs(raw - lastTime) > 0.25 { seekState.request(lastTime) }
        }
        lifecycle.play()
        // A terminated input must reopen through the unit's bounded recovery at
        // its saved clock. libvlc play() alone would start that input from zero.
        if opened && (player.state == .stopped || player.state == .error) { failed(); return }
        guard opened else { return } // Paused preparation is already opening the input.
        if pendingSeek != nil { applyPendingSeek(); return }
        player.play()
    }
    func pause() {
        lastTime = currentTime
        lifecycle.pause()
        player.pause()
    }
    func seek(_ seconds: Double) {
        steppedPicture = false
        frameStepAttempts = 0
        initialTime = max(0, seconds)
        lastTime = initialTime
        seekState.request(initialTime)
        lifecycle.seek()
        applyPendingSeek()
    }

    private func applyPendingSeek() {
        guard !stopped, opened, !seekInFlight, player.isSeekable, pendingSeek != nil else { return }
        guard let request = seekState.begin() else { return }
        let target = request.target
        let raw = (player.time.value?.doubleValue ?? 0) / 1000
        let milliseconds = max(Double(Int32.min), min(Double(Int32.max), ((target - raw) * 1000).rounded()))
        let pictures = media.statistics.displayedPictures
        let accepted = player.jump(withOffset: Int32(milliseconds), completion: { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.stopped else { return }
                switch self.seekState.complete(request) {
                case .ignored: return
                case .retry: self.applyPendingSeek(); return
                case .settled: break
                }
                self.lastTime = target
                if self.surface.isHidden || !self.requested { self.firstPictureAfterSeek = pictures }
                if self.requested { self.player.play() }
                else { self.player.pause(); self.preparePausedPicture() }
                self.changed()
            }
        })
        if !accepted { seekState.rejected(request) }
    }

    private func preparePausedPicture() {
        guard !stopped, !requested, opened, videoEnabled,
              UIApplication.shared.applicationState == .active,
              player.state == .paused, pendingSeek == nil, !seekInFlight,
              !frameStepInFlight, frameStepAttempts < 2,
              !hasPicture || firstPictureAfterSeek != nil else { return }
        // start-paused can stop before the decoder has supplied a picture.
        // VLCKit's native step requests one displayed frame without playback.
        frameStepAttempts += 1
        frameStepInFlight = true
        player.gotoNextFrame()
    }

    nonisolated func mediaPlayer(_ player: VLCMediaPlayer, nextFrameSteppedWith result: VLCMediaPlayerFrameStepResult) {
        Task { @MainActor [weak self] in
            guard let self, !self.stopped else { return }
            self.frameStepInFlight = false
            self.frameStepEvents.append(["result": result.rawValue, "clock": self.player.time.value?.doubleValue ?? -1])
            if self.frameStepEvents.count > 16 { self.frameStepEvents.removeFirst() }
            if result == .success, self.pendingSeek == nil, !self.seekInFlight {
                self.steppedPicture = true
                self.firstPictureAfterSeek = nil
                if self.videoEnabled { self.surface.isHidden = false }
            }
            if self.requested { self.player.play() }
            self.changed()
        }
    }

    func setVideoEnabled(_ enabled: Bool) {
        output.request(enabled)
        // Keep audio and the media clock running through lock/background. Removing
        // only the video track prevents background rendering without restarting it.
        if enabled {
            restoreVideoIfReady()
        }
        else { player.deselectAllVideoTracks() }
    }

    private func restoreVideoIfReady() {
        // willEnterForeground can still report a background application. Do not
        // create the native video output until UIKit has actually activated it.
        guard !stopped, videoRestorePending, videoEnabled, opened,
              UIApplication.shared.applicationState == .active, !player.videoTracks.isEmpty else { return }
        output.restored()
        let position = currentTime
        player.selectTrack(at: 0, type: .video)
        // VP9 Matroska needs random-access preroll after video-only suspension.
        // Rejoin the current clock on this input, preserving a queued user seek.
        if !ended, pendingSeek == nil {
            lastTime = position
            seekState.request(position)
            applyPendingSeek()
        }
    }

    func stop() {
        guard !stopped else { return }
        lifecycle.stop()
        seekState.cancel()
        lifecycle.pause()
        timer?.invalidate(); timer = nil
        if player.state == .stopped {
            finishRetirement()
            return
        }
        let id = UUID()
        retirement = id
        Self.retiring[id] = self
        player.stop()
    }

    private func finishRetirement() {
        lifecycle.retired()
        player.delegate = nil
        player.drawable = nil
        if let retirement {
            self.retirement = nil
            Self.retiring.removeValue(forKey: retirement)
        }
    }

    // VLCKit delivers delegate notifications on its main event queue. Keep late
    // notifications from a recycled unit from changing playback intent.
    nonisolated func mediaPlayerStateChanged(_ state: VLCMediaPlayerState) {
        Task { @MainActor [weak self] in self?.stateChanged(state) }
    }

    private func stateChanged(_ state: VLCMediaPlayerState) {
        if stopped {
            if state == .stopped { finishRetirement() }
            else if state == .playing || state == .paused { player.stop() }
            return
        }
        stateEvents.append(["state": state.rawValue, "clock": player.time.value?.doubleValue ?? -1,
                            "position": player.position, "requested": requested])
        if stateEvents.count > 16 { stateEvents.removeFirst() }
        if state == .playing {
            guard lifecycle.openedInput() else { if player.isPlaying { player.pause() }; return }
            if !requested || pendingSeek != nil { player.pause() }
            applyPendingSeek()
            if !videoEnabled { player.deselectAllVideoTracks() }
        }
        if state == .paused {
            guard lifecycle.observedPause() else { if player.isPlaying { player.pause() }; return }
            if pendingSeek != nil { applyPendingSeek() }
            else if requested { player.play() }
            else { preparePausedPicture() }
        }
        if state == .error { lifecycle.fail() }
        let nativeTime = max(lastTime, (player.time.value?.doubleValue ?? 0) / 1000)
        if state == .stopped && opened && VideoTerminalState.reachedEnd(duration: duration, time: nativeTime, position: player.position, inputFailed: inputFailed) {
            lifecycle.end()
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
                "nativeTime": (player.time.value?.doubleValue ?? 0) / 1000, "nativePosition": player.position,
                "stateEvents": stateEvents,
                "frameStepEvents": frameStepEvents,
                "retiringDecoders": Self.retiringCount,
                "ended": ended, "inputFailed": inputFailed,
                "duration": duration, "rate": playing ? 1 : 0, "status": player.state.rawValue,
                "width": size.width, "height": size.height, "bytesTransferred": stats.readBytes,
                "decodedVideoFrames": stats.decodedVideo, "displayedVideoFrames": stats.displayedPictures,
                "lateVideoFrames": stats.latePictures, "droppedVideoFrames": stats.lostPictures]
    }
}
#endif
