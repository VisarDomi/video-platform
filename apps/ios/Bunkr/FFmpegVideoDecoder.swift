#if canImport(AetherEngine)
import AetherEngine
import AVFoundation
import Combine
import UIKit
import VideoToolbox

#if ORIGINAL_CODEC_PROBE
private final class InlineProbeFrameTimes: @unchecked Sendable {
    private let lock = NSLock()
    private var generation: UInt64 = 0
    private var times: [Double] = []
    func record(_ frame: SoftwareVideoFrameTime) {
        let seconds = frame.presentation.seconds
        guard seconds.isFinite else { return }
        lock.lock(); defer { lock.unlock() }
        guard frame.generation >= generation else { return }
        if frame.generation != generation { generation = frame.generation; times.removeAll(keepingCapacity: true) }
        times.append(seconds)
        if times.count > 512 { times.removeFirst(times.count-512) }
    }
    func latest(at clock: Double) -> Double? {
        lock.lock(); defer { lock.unlock() }
        return times.last { $0 <= clock }
    }
}
#endif

// FFmpeg demuxes the unchanged source. The direct sample-buffer path selects
// VideoToolbox where available and dav1d/libavcodec otherwise; it never creates
// a replacement video or a local remux/loopback playback stream.
@MainActor
final class FFmpegVideoDecoder: ViewerDecoder {
    private(set) static var preparingCount = 0
    // Registration can discover/load a system decoder. Share it across units
    // and keep that initialization away from the viewer's main thread.
    private static let vp9Hardware = Task.detached(priority: .userInitiated) {
        if #available(iOS 26.2, *) {
            VTRegisterSupplementalVideoDecoderIfAvailable(kCMVideoCodecType_VP9)
        }
        return VTIsHardwareDecodeSupported(kCMVideoCodecType_VP9)
    }
    private let engine: AetherEngine
    private let display: AetherPlayerView
    private let video: ViewerVideo
    private let sourceURL: URL
    private let options: LoadOptions
    private let requiresHardware: Bool
    private let changed: () -> Void
    private let failed: () -> Void
    private var timer: Timer?
    private var subscriptions = Set<AnyCancellable>()
    private var lifecycle = DecoderLifecycle()
    private var requested: Bool { lifecycle.requested }
    private var stopped: Bool { lifecycle.stopping }
    private var picture = false
    private var mutedValue = true
    private var output = VideoOutputState.enabled
    private var videoEnabled: Bool { output.requested }
    private var videoRestorePending: Bool { output.needsRestore }
    private var seekState = ChasingSeek()
    private var target: Double? { seekState.target }
    private var lastTime: Double = 0
    private var seekTask: Task<Void, Never>?
    private var reading = false
    private var terminal: Bool { lifecycle.terminal }
    private var rendered = 0
    private var dropped = 0
    private var corrupted = 0
    #if ORIGINAL_CODEC_PROBE
    private let frameTimes = InlineProbeFrameTimes()
    #endif

    static func create(source: MediaSource, video: ViewerVideo, surface: UIView, start: Double,
                       changed: @escaping () -> Void, failed: @escaping () -> Void,
                       requiresHardware: Bool = true) async -> FFmpegVideoDecoder? {
        preparingCount += 1
        defer { preparingCount -= 1 }
        if requiresHardware {
            guard await vp9Hardware.value else { return nil }
        }
        var prepared: FFmpegVideoDecoder?
        do {
            try Task.checkCancellation()
            let engine = try AetherEngine()
            let display = AetherPlayerView(frame: surface.bounds)
            display.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            display.isUserInteractionEnabled = false
            surface.addSubview(display)
            engine.bind(view: display)
            engine.rendererAudioSessionActivationEnabled = false
            engine.deactivatesAudioSessionOnStop = false
            engine.backgroundPlaybackEnabled = true
            engine.automaticallyRewindsBeforePlay = false
            engine.volume = 0
            engine.videoGravity = .resizeAspect
            var options = LoadOptions(suppressDisplayCriteria: true, displayCriteriaOwner: .host, matchContentEnabled: false,
                                      declaredDurationSeconds: video.declaredDuration,
                                      probesize: 1_000_000, maxAnalyzeDuration: 1_000_000,
                                      skipsContainerAttachments: true, sessionCacheByteBudget: 16 * 1024 * 1024,
                                      softwarePacketCacheStorage: .memory, autoplay: false, preferredDecodePath: .software)
            options.maxConcurrentSourceRequests = 2
            let decoder = FFmpegVideoDecoder(engine: engine, display: display, video: video,
                                            sourceURL: source.url, options: options, requiresHardware: requiresHardware,
                                            changed: changed, failed: failed)
            prepared = decoder
            try await decoder.prepare(at: start)
            decoder.startObserving()
            return decoder
        } catch {
            prepared?.stop()
            print("Original FFmpeg decoder preparation failed:", error.localizedDescription)
            return nil
        }
    }

    private init(engine: AetherEngine, display: AetherPlayerView, video: ViewerVideo,
                 sourceURL: URL, options: LoadOptions, requiresHardware: Bool,
                 changed: @escaping () -> Void, failed: @escaping () -> Void) {
        self.engine = engine; self.display = display; self.video = video
        self.sourceURL = sourceURL; self.options = options; self.requiresHardware = requiresHardware
        self.changed = changed; self.failed = failed
        #if ORIGINAL_CODEC_PROBE
        let times = frameTimes
        engine.setSoftwareVideoFrameTimeObserver { frame in times.record(frame) }
        #endif
    }

    private func prepare(at seconds: Double) async throws {
        try await engine.load(url: sourceURL, startPosition: max(0, seconds), options: options)
        try Task.checkCancellation()
        guard !stopped, engine.videoRoute == .software,
              !requiresHardware || engine.inlineHardwareDecoder == true else {
            throw NSError(domain: "Original decoder unavailable", code: 1)
        }
        lifecycle.openedInput()
        lastTime = max(0, seconds)
        engine.volume = mutedValue ? 0 : 1
        // load(autoplay:false) opens the input without starting its feed loops.
        // Start them and park the clock synchronously for a paused first picture.
        engine.play()
        engine.pause()
    }

    private func startObserving() {
        engine.$hasFirstFrameReadyForDisplay.sink { [weak self] ready in
            guard ready, let self, !self.stopped, !self.picture else { return }
            self.picture = true
            self.changed()
        }.store(in: &subscriptions)
        NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification).sink { [weak self] _ in
            MainActor.assumeIsolated { self?.restoreVideoIfReady() }
        }.store(in: &subscriptions)
        engine.$state.sink { [weak self] state in
            guard let self, !self.stopped else { return }
            if case .ended = state, self.target == nil { self.lastTime = self.duration; self.lifecycle.end() }
            if case .error = state { self.lifecycle.fail(); self.failed() }
            self.changed()
        }.store(in: &subscriptions)
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
        sample()
    }

    private func sample() {
        guard !stopped else { return }
        changed()
        #if ORIGINAL_CODEC_PROBE
        guard !reading, videoEnabled else { return }
        reading = true
        Task { [weak self] in
            guard let self else { return }
            let metrics = await self.engine.inlineRenderStatistics()
            self.reading = false
            guard !self.stopped, let metrics else { return }
            self.rendered = max(0, metrics.total - metrics.dropped)
            self.dropped = metrics.dropped
            self.corrupted = metrics.corrupted
        }
        #endif
    }

    var currentTime: Double {
        if let target { return target }
        guard !lifecycle.failed, !stopped, !terminal else { return lastTime }
        let time = engine.currentTime
        if time.isFinite && time >= 0 { lastTime = time }
        return lastTime
    }
    var duration: Double { max(engine.duration, video.duration) }
    var size: CGSize { video.displaySize ?? engine.softwareDisplaySize ?? CGSize(width: CGFloat(engine.sourceVideoWidth), height: CGFloat(engine.sourceVideoHeight)) }
    var playing: Bool { requested && engine.state == .playing }
    var hasPicture: Bool { !stopped && picture && videoEnabled && !videoRestorePending }
    var reachedEnd: Bool { terminal }
    var muted: Bool {
        get { mutedValue }
        set { mutedValue = newValue; engine.volume = newValue ? 0 : 1 }
    }

    func play() {
        guard !stopped, !terminal else { return }
        lifecycle.play()
        if target == nil { engine.play() }
    }
    func pause() {
        lifecycle.pause()
        engine.pause()
    }
    func seek(_ seconds: Double) {
        guard !stopped, seconds.isFinite else { return }
        lifecycle.seek()
        let target = duration > 0 ? min(duration, max(0, seconds)) : max(0, seconds)
        seekState.request(target)
        lastTime = target
        guard seekTask == nil else { return }
        seekTask = Task { [weak self] in
            guard let self else { return }
            defer { self.seekTask = nil; self.changed() }
            seekLoop: while !self.stopped, !Task.isCancelled, let request = self.seekState.begin() {
                if self.engine.state == .ended {
                    self.picture = false
                    do { try await self.prepare(at: request.target) }
                    catch {
                        self.seekState.cancel()
                        if !self.stopped, !Task.isCancelled { self.lifecycle.fail(); self.failed() }
                        break
                    }
                } else { await self.engine.seek(to: request.target, exact: true) }
                guard !self.stopped, !Task.isCancelled, !self.lifecycle.failed else { break }
                switch self.seekState.complete(request) {
                case .ignored: break seekLoop
                case .retry: continue
                case .settled(let target): self.lastTime = target
                }
                if self.requested { self.engine.play() } else { self.engine.pause() }
            }
        }
    }
    func setVideoEnabled(_ enabled: Bool) {
        guard videoEnabled != enabled else { return }
        output.request(enabled)
        if enabled {
            restoreVideoIfReady()
        } else {
            engine.setInlineVideoEnabled(false)
            display.isHidden = true
        }
    }

    private func restoreVideoIfReady() {
        guard !stopped, videoEnabled, videoRestorePending,
              UIApplication.shared.applicationState == .active else { return }
        output.restored()
        let position = currentTime
        engine.setInlineVideoEnabled(true)
        display.isHidden = false
        // Playing audio keeps its clock and queued samples. Video resumes on a
        // keyframe while the same surface retains its picture. A paused input
        // needs a still at its saved clock; no audio is running in that case.
        if !terminal, !requested, target == nil { seek(position) }
    }
    func stop() {
        guard !stopped else { return }
        lifecycle.stop()
        timer?.invalidate(); timer = nil
        seekTask?.cancel(); seekTask = nil; seekState.cancel()
        subscriptions.removeAll()
        engine.stop(resetDisplayCriteria: false, finalTeardown: true)
        lifecycle.retired()
        engine.unbind(view: display)
        display.removeFromSuperview()
    }
    var evidence: [String: Any] {
        var value: [String: Any] = ["engine": "FFmpeg/VideoToolbox", "codec": video.videoCodec ?? "unknown",
         "hardwareDecoder": engine.inlineHardwareDecoder ?? false, "hardwareKnown": engine.inlineHardwareDecoder != nil,
         "audioDelivery": engine.audioDelivery.rawValue,
         "currentTime": currentTime, "nativeTime": max(0, engine.currentTime), "hasPicture": hasPicture, "duration": duration, "rate": playing ? 1 : 0,
         "width": size.width, "height": size.height, "decodedVideoFrames": engine.softwareHostFramesEnqueued,
         "retiringDecoders": AetherEngine.inlineRetiringDecoderCount,
         "route": engine.videoRoute.rawValue, "ended": terminal]
        #if ORIGINAL_CODEC_PROBE
        value["displayedVideoFrames"] = rendered
        value["droppedVideoFrames"] = dropped
        value["corruptedVideoFrames"] = corrupted
        value["engineState"] = String(describing: engine.state)
        value["engineDuration"] = engine.duration
        value["sessionReady"] = engine.isSessionReady
        let clock = engine.inlineAudioClock ?? max(0, engine.currentTime)
        value["nativeTime"] = clock
        if let presented = frameTimes.latest(at: clock) { value["presentedSourceTime"] = presented }
        #endif
        return value
    }
}
#endif
