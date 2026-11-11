import AVFoundation
import UIKit
import KitCore

// The web viewer's PlayerUnit (packages/app src/player/PlayerUnit.ts) with AVPlayer: one video,
// its timeline and its media lifecycle. Videos never stop by themselves: a failed or stalled
// item recovers at its position, except a live stream that ended (onUnavailable).
@MainActor
protocol ViewerUnitDelegate: AnyObject {
    func unitTime(_ unit: ViewerUnit, _ snapshot: TimelineSnapshot)
    func unitLiveChanged(_ unit: ViewerUnit, _ isLive: Bool)
    func unitMutedChanged(_ unit: ViewerUnit, _ muted: Bool)
    func unitUnavailable(_ unit: ViewerUnit)
    func unitGeometryChanged(_ unit: ViewerUnit)
    func unitNeedsLogin(_ unit: ViewerUnit)
    func unitSource(_ video: ViewerVideo) async throws -> MediaSource
    func unitAsset(_ source: MediaSource, for video: ViewerVideo) async -> AVURLAsset
}

final class PlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    override init(frame: CGRect) {
        super.init(frame: frame)
        playerLayer.videoGravity = .resizeAspect
        backgroundColor = .black
        isUserInteractionEnabled = false
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
}

@MainActor
final class ViewerUnit {
    let view = PlayerView()
    let player = AVPlayer()
    private(set) var video: ViewerVideo?
    // The decoded picture's size: the layout's authority, as the web viewer's intrinsic geometry.
    private(set) var presentationSize: CGSize = .zero
    weak var delegate: ViewerUnitDelegate?
    // Whether this unit should be playing; the Bunkr library keeps neighbours paused.
    private var playback = VideoPlaybackState()
    var wantsPlay: Bool { playback.requested }

    private var timeline = Timeline()
    private var token = 0
    private var resolving: Bool { playback.phase == .resolving }
    private var playerObservations: [NSKeyValueObservation] = []
    private var observations: [NSKeyValueObservation] = []
    private var notifications: [NSObjectProtocol] = []
    private var timeObserver: Any?
    private var lastTimeEmit: CFTimeInterval = 0
    private var startTime: Double = 0
    private var started: Bool { playback.started }
    private var playlistTask: Task<Void, Never>?
    private var playlistRefresh: Timer?
    private var recovery: Timer?
    private var failures = 0
    private var seekState = ChasingSeek()
    private var seeking: Bool { seekState.isInFlight }
    private var seekDone: [() -> Void] = []
    private var pictureCheck: Timer?
    private var playbackPolicy = ViewerPlaybackPolicy(provider: "")
    private var playRequestedAt: CFTimeInterval?
    private var playStartedMs: Double?
    private var decoder: (any ViewerDecoder)?
    private var decoderLoadTask: Task<Void, Never>?
    private var decoderSurface: UIView?
    private var alternateKey: String?
    private var videoEnabled = true
    // Bounded seek evidence for the playback samples: how long the last request took to show.
    private var seekRequestedAt: CFTimeInterval?
    private var seekEvidence: [String: Any] = ["seeks": 0]
    // Where the playhead was when the current gesture's seeks began. Its seeks land on
    // keyframes between there and the finger, so they never cross it.
    private var seekOrigin: Double?
    private var seekGestureOpen = false
    // The keyframe the gesture's last seek landed on.
    private var seekLanding: Double?
    private var completedSeeks = 0
    // A drag holds playback still between its seeks; the finger lifting continues it.
    private var scrubHold = false
    // A paused neighbour holds no player: its media opens when it becomes the video being
    // watched. Until then it shows a still of the keyframe it will open on (NeighbourPoster).
    private var staged: (video: ViewerVideo, alternate: Bool, token: Int)?
    private let posterView = UIImageView()
    private var posterAttempted = false
    // While the document scrolls, stopping the video left behind and opening the one that
    // took the middle both wait for it to rest (Neighbours): each costs the main thread
    // frames that a moving document would show as a stutter.
    private var pausePending = false
    private var startPending = false
    private var deferredAt: CFTimeInterval = 0
    private var posterReady: NSKeyValueObservation?
    private var pausedAt: CFTimeInterval = 0

    init() {
        player.isMuted = true
        player.automaticallyWaitsToMinimizeStalling = true
        player.preventsDisplaySleepDuringVideoPlayback = true
        view.playerLayer.player = player
        view.isHidden = true
        playerObservations.append(player.observe(\.isMuted, options: [.new]) { [weak self] player, _ in
            MainActor.assumeIsolated { if let self { self.delegate?.unitMutedChanged(self, player.isMuted) } }
        })
        playerObservations.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated { self?.timeControlChanged() }
        })
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.timeUpdate() }
        }
        posterView.contentMode = .scaleAspectFit
        posterView.backgroundColor = .black
        posterView.isHidden = true
        posterView.frame = view.bounds
        posterView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(posterView)
        posterReady = view.playerLayer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.updatePoster() }
        }
        Neighbours.units.add(self)
    }

    var muted: Bool {
        get { decoder?.muted ?? player.isMuted }
        set {
            player.isMuted = newValue
            decoder?.muted = newValue
        }
    }

    var isPlaying: Bool { decoder?.playing ?? (player.rate > 0) }
    var hasPicture: Bool { decoder?.hasPicture ?? view.playerLayer.isReadyForDisplay }

    func setVideoEnabled(_ enabled: Bool) {
        videoEnabled = enabled
        view.playerLayer.player = enabled ? player : nil
        decoder?.setVideoEnabled(enabled)
    }

    var hasMedia: Bool { video != nil && !view.isHidden }
    var clockSeconds: Double { currentSeconds() }
    var frameSerial: Int { decoder?.frameSerial ?? (completedSeeks + (view.playerLayer.isReadyForDisplay ? 1 : 0)) }

    #if targetEnvironment(simulator)
    func configureZoomCheck(video: ViewerVideo, size: CGSize, image: UIImage) {
        self.video = video
        presentationSize = size
        view.isHidden = false
        view.subviews.forEach { $0.removeFromSuperview() }
        let picture = UIImageView(image: image)
        // A real aspect-fit image, including delayed-metadata cases. Do not stretch a
        // calibration image to mask an incorrectly reserved player rectangle.
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let target = CGSize(width: 288, height: max(1, min(2048, 288 * size.height / max(1, size.width))))
        let source = UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        picture.image = source
        picture.contentMode = .scaleAspectFit
        picture.frame = view.bounds
        picture.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(picture)
    }
    func configurePendingMetadataCheck(video: ViewerVideo) {
        self.video = video
        presentationSize = .zero
        view.isHidden = false
        view.subviews.forEach { $0.removeFromSuperview() }
    }
    #endif

    func load(_ video: ViewerVideo, start: Double, play: Bool) {
        FrameMonitor.shared.measure("unit.load") { loadNow(video, start: start, play: play) }
    }

    private func loadNow(_ video: ViewerVideo, start: Double, play: Bool) {
        let alternate = ViewerDecoders.available && (video.needsAlternateDecoder || alternateKey == video.key)
        if let current = self.video, current.same(video), (player.currentItem != nil || decoder != nil), alternate == (decoder != nil) {
            self.video = video
            play ? self.play() : pause()
            return
        }
        token += 1
        let token = token
        clearMedia()
        self.video = video
        playbackPolicy = ViewerPlaybackPolicy(provider: video.provider)
        player.automaticallyWaitsToMinimizeStalling = playbackPolicy.waitsToMinimizeStalling
        timeline = Timeline()
        startTime = start
        playback.load(play: play)
        playRequestedAt = play ? CACurrentMediaTime() : nil
        playStartedMs = nil
        failures = 0
        pausedAt = CACurrentMediaTime()
        view.isHidden = false
        showPoster(video, at: start, token: token)
        // Only the video being watched opens its media. A paused neighbour shows its still.
        if play { beginMedia(video, alternate: alternate, token: token) }
        else {
            staged = (video, alternate, token)
            Neighbours.changed()
        }
        reportKnownSize(video, token: token, attempt: 0)
    }

    // The PC probed the picture's size: the viewer shows the video (its still, then its
    // first picture) without waiting for the player to report it. A viewer that is being
    // opened has not laid out its document yet; it is told once it has.
    private func reportKnownSize(_ video: ViewerVideo, token: Int, attempt: Int) {
        guard token == self.token, let size = video.displaySize, presentationSize == .zero else { return }
        let document = view.superview?.superview as? UIScrollView
        guard let document, document.bounds.height > 0, document.window != nil else {
            guard attempt < 60 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.008) { [weak self] in
                self?.reportKnownSize(video, token: token, attempt: attempt + 1)
            }
            return
        }
        presentationSize = size
        delegate?.unitGeometryChanged(self)
    }

    private func showPoster(_ video: ViewerVideo, at seconds: Double, token: Int) {
        posterAttempted = false
        posterView.image = NeighbourPoster.cached(video, at: seconds)
        updatePoster()
        guard posterView.image == nil else { return }
        Task { [weak self] in
            guard let image = await NeighbourPoster.stored(video, at: seconds), let self, token == self.token,
                  self.posterView.image == nil else { return }
            self.posterView.image = image
            self.updatePoster()
        }
    }

    // The still covers the unit until its player has a picture of its own.
    private func updatePoster() {
        let hidden = posterView.image == nil || hasPicture
        if posterView.isHidden != hidden { posterView.isHidden = hidden }
    }

    var showsPoster: Bool { !posterView.isHidden }

    // Neighbours' turn for this unit: read its keyframe from the original file.
    fileprivate var needsPoster: Bool { staged != nil && posterView.image == nil && !posterAttempted }
    fileprivate func makePoster() async {
        guard let video, let delegate else { return }
        let token = token, seconds = startTime
        posterAttempted = true
        guard let source = try? await delegate.unitSource(video), token == self.token,
              let image = await NeighbourPoster.make(video, source: source, at: seconds), token == self.token else { return }
        posterView.image = image
        updatePoster()
    }

    // A neighbour that was watched keeps its player for a quick return; an older one gives
    // it up and becomes a still at the place it stopped.
    fileprivate var holdsPausedMedia: Bool {
        video != nil && staged == nil && !wantsPlay && (decoder != nil || player.currentItem != nil || decoderLoadTask != nil)
    }
    fileprivate var pausedSince: CFTimeInterval { pausedAt }
    fileprivate func releaseMedia() {
        guard let video, holdsPausedMedia, view.isHidden else { return }
        let time = currentSeconds()
        self.video = nil
        load(video, start: time, play: false)
        // Still a neighbour at rest: only the viewer shows it, while the document scrolls.
        view.isHidden = true
    }

    private func beginMedia(_ video: ViewerVideo, alternate: Bool, token: Int) {
        staged = nil
        let loading = Task { [weak self] in
            guard let self, let delegate else { return }
            defer { if token == self.token { self.decoderLoadTask = nil } }
            do {
                let source = try await delegate.unitSource(video)
                guard token == self.token, !Task.isCancelled else { return }
                if alternate {
                    await attachDecoder(source, video: video, token: token)
                    return
                }
                let asset = await delegate.unitAsset(source, for: video)
                guard token == self.token, !Task.isCancelled else { return }
                playback.resolved()
                attach(AVPlayerItem(asset: asset), token: token)
                if video.local { refreshPlaylist(video, token: token) }
            } catch {
                guard token == self.token, !Task.isCancelled else { return }
                playback.resolved()
                if case ViewerFailure.authentication = error { delegate.unitNeedsLogin(self) }
                else if video.liveStream { delegate.unitUnavailable(self) }
                else { print("Video source resolution failed:", error.localizedDescription); scheduleRecovery() }
            }
        }
        // Source generation already protects visibility. Cancellation also lets
        // the original-file backend close a superseded open before it finishes.
        if alternate && video.provider == "bunkr" { decoderLoadTask = loading }
    }

    // The unit became the one being watched.
    fileprivate func beginStagedMedia() {
        guard let staged, staged.token == token else { staged = nil; return }
        beginMedia(staged.video, alternate: staged.alternate, token: staged.token)
    }

    fileprivate var isStaged: Bool { staged != nil }
    // Requested, and not yet seen moving for half a second (four seconds at most).
    fileprivate var isStarting: Bool {
        guard wantsPlay, video != nil, staged == nil, let requested = playRequestedAt else { return false }
        let now = CACurrentMediaTime()
        guard let started = playStartedMs else { return now - requested < 4 }
        return now - (requested + started / 1000) < 0.5
    }
    fileprivate var viewportDistance: CGFloat {
        guard let feed = view.superview?.superview as? UIScrollView else { return .greatestFiniteMagnitude }
        return abs(view.frame.midY - (feed.contentOffset.y + feed.bounds.height / 2))
    }

    private func attach(_ item: AVPlayerItem, token: Int) {
        item.preferredForwardBufferDuration = playbackPolicy.forwardBuffer(playing: wantsPlay)
        observations.append(item.observe(\.status, options: [.new]) { [weak self] item, _ in
            MainActor.assumeIsolated { self?.statusChanged(item, token: token) }
        })
        observations.append(item.observe(\.presentationSize, options: [.new]) { [weak self] item, _ in
            MainActor.assumeIsolated {
                guard let self, token == self.token, item.presentationSize != self.presentationSize else { return }
                self.presentationSize = item.presentationSize
                self.delegate?.unitGeometryChanged(self)
            }
        })
        observations.append(item.observe(\.duration, options: [.new]) { [weak self] _, _ in
            MainActor.assumeIsolated {
                guard let self, token == self.token else { return }
                self.emitTime()
                self.reconcileFinalization()
            }
        })
        if !playbackPolicy.waitsToMinimizeStalling {
            observations.append(item.observe(\.isPlaybackBufferEmpty, options: [.new]) { [weak self] item, _ in
                Task { @MainActor in self?.resumeBufferedPlayback(item, token: token) }
            })
            observations.append(item.observe(\.loadedTimeRanges, options: [.new]) { [weak self] item, _ in
                Task { @MainActor in self?.resumeBufferedPlayback(item, token: token) }
            })
        }
        let center = NotificationCenter.default
        notifications.append(center.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.failed(token: token) }
        })
        notifications.append(center.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.ended(token: token) }
        })
        notifications.append(center.addObserver(forName: AVPlayerItem.playbackStalledNotification, object: item, queue: .main) { [weak self] _ in
            // AVPlayer waits for data by itself; a stall that leaves it stopped is nudged back.
            MainActor.assumeIsolated {
                guard let self, token == self.token, self.playback.canPlay, !self.scrubHold else { return }
                self.player.play()
            }
        })
        // The item opens on the keyframe at or before the saved position: one decoded picture.
        // Loading from zero and then seeking exactly decodes up to a whole group of pictures.
        if startTime > 0, video?.liveStream != true {
            item.seek(to: CMTime(seconds: startTime, preferredTimescale: 600), toleranceBefore: .positiveInfinity,
                      toleranceAfter: .zero, completionHandler: nil)
        }
        FrameMonitor.shared.measure("unit.attach") { player.replaceCurrentItem(with: item) }
        if wantsPlay { player.play() }
    }

    private func statusChanged(_ item: AVPlayerItem, token: Int) {
        guard token == self.token else { return }
        switch item.status {
        case .readyToPlay:
            failures = 0
            timeline.observe(player)
            if !started {
                playback.ready()
                if wantsPlay { player.play() }
            }
            emitTime()
            resumeBufferedPlayback(item, token: token)
        case .failed:
            print("Video item failed:", item.error?.localizedDescription ?? "unknown")
            failed(token: token)
        default:
            break
        }
    }

    private func failed(token: Int) {
        guard token == self.token, playback.phase != .ended, playback.phase != .empty else { return }
        if video?.liveStream == true { delegate?.unitUnavailable(self); return }
        if useAlternateDecoder() { return }
        scheduleRecovery()
    }

    private func useAlternateDecoder() -> Bool {
        guard ViewerDecoders.available, decoder == nil, let video, video.provider == "bunkr" else { return false }
        alternateKey = video.key
        reload()
        return true
    }

    private func attachDecoder(_ source: MediaSource, video: ViewerVideo, token: Int) async {
        let surface = UIView(frame: view.bounds)
        surface.backgroundColor = .black
        surface.isUserInteractionEnabled = false
        surface.clipsToBounds = true
        surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.insertSubview(surface, belowSubview: posterView)
        let prepared = await ViewerDecoders.make(source: source, video: video, surface: surface, start: startTime,
            changed: { [weak self] in
                guard let self, self.token == token else { return }
                self.timeUpdate()
            }, failed: { [weak self] in
                guard let self, self.token == token else { return }
                self.scheduleRecovery()
            })
        guard token == self.token else { prepared?.stop(); surface.removeFromSuperview(); return }
        decoderSurface = surface
        decoder = prepared
        playback.resolved()
        guard decoder != nil else { surface.removeFromSuperview(); decoderSurface = nil; scheduleRecovery(); return }
        playback.ready()
        decoder?.muted = player.isMuted
        decoder?.setVideoEnabled(videoEnabled)
        if wantsPlay { decoder?.play() }
    }

    // With automatic startup waiting disabled, AVPlayer pauses on an empty buffer.
    // Resume only the selected, requested video when data returns; never undo a user pause.
    private func resumeBufferedPlayback(_ item: AVPlayerItem, token: Int) {
        guard token == self.token, item === player.currentItem, item.status == .readyToPlay,
              player.timeControlStatus == .paused, !scrubHold else { return }
        let time = player.currentTime().seconds, end = item.loadedTimeRanges.last?.timeRangeValue.end.seconds ?? 0
        let duration = item.duration.seconds
        let ended = duration.isFinite && duration > 0 && time >= duration - 0.1
        let data = !item.isPlaybackBufferEmpty && end.isFinite && time.isFinite && end - time > 0.05
        guard playbackPolicy.resumesBufferedPlayback(requested: wantsPlay, hasData: data, ended: ended, seeking: seeking) else { return }
        player.play()
    }

    // A live stream ends when its playlist does; recordings stop at their end.
    private func ended(token: Int) {
        guard token == self.token else { return }
        emitTime()
        reconcileFinalization()
        if !timeline.snapshot().isLive && video?.liveStream != true {
            guard playback.acceptsEnd(seeking: seekState.target != nil, current: player.currentTime().seconds,
                                      duration: player.currentItem?.duration.seconds ?? .nan) else { return }
            playback.end()
        }
        if video?.liveStream == true { delegate?.unitUnavailable(self) }
    }

    // As in Stream Viewer: a live stream that "plays" without any picture has ended.
    private func timeControlChanged() {
        notePlaybackStarted()
        pictureCheck?.invalidate()
        pictureCheck = nil
        guard (video?.liveStream == true || video?.provider == "bunkr"), player.timeControlStatus == .playing else { return }
        let token = token
        pictureCheck = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, token == self.token, self.player.timeControlStatus == .playing,
                      self.player.currentItem?.presentationSize == .zero else { return }
                if self.video?.liveStream == true { self.delegate?.unitUnavailable(self) }
                else { _ = self.useAlternateDecoder() }
            }
        }
    }

    // Reload at the same position, backing off to 30 s; the video carries on once it can.
    private func scheduleRecovery() {
        guard playback.recover() else { return }
        recovery?.invalidate()
        failures += 1
        let delay = min(30, pow(2, Double(min(failures, 5) - 1)))
        let token = token
        recovery = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, token == self.token else { return }
                self.reload()
            }
        }
    }

    private func reload() {
        guard let video else { return }
        let time = video.liveStream ? 0 : currentSeconds()
        let play = wantsPlay
        let failures = failures
        self.video = nil
        load(video, start: time, play: play)
        self.failures = failures
    }

    func clear() {
        // Left while it was open: the place it stopped at is where it opens next time.
        if let video, staged == nil, decoder != nil || player.currentItem != nil, !video.liveStream, let source = video.media {
            NeighbourPoster.keep(video, source: source, at: currentSeconds())
        }
        token += 1
        clearMedia()
        video = nil
        timeline = Timeline()
        playback.pause()
        view.isHidden = true
    }

    func update(_ video: ViewerVideo) {
        self.video = video
        // The viewer calls this for every unit it keeps, on every scroll step.
        Neighbours.noteScroll(document)
    }

    fileprivate var document: UIScrollView? { view.superview?.superview as? UIScrollView }
    fileprivate var hasDeferredWork: Bool { pausePending || startPending }
    fileprivate var deferredSince: CFTimeInterval { deferredAt }
    fileprivate func runDeferred() {
        if pausePending { pauseMedia() }
        guard startPending else { return }
        startPending = false
        if wantsPlay, staged != nil { beginStagedMedia() }
    }

    func play() { FrameMonitor.shared.measure("unit.play") { playNow() } }

    private func playNow() {
        if !wantsPlay { playRequestedAt = CACurrentMediaTime(); playStartedMs = nil }
        seekGestureOpen = false
        scrubHold = false
        guard playback.play() else { return }
        // Scrolled back before it was stopped: it never stopped.
        pausePending = false
        if staged != nil {
            if Neighbours.documentMoving(document) {
                startPending = true
                deferredAt = CACurrentMediaTime()
                Neighbours.changed()
            } else { beginStagedMedia() }
            return
        }
        if let decoder { decoder.play(); return }
        player.currentItem?.preferredForwardBufferDuration = playbackPolicy.forwardBuffer(playing: true)
        if let item = player.currentItem, item.status == .failed { reload(); return }
        if player.currentItem == nil, video != nil, recovery == nil, !resolving { reload(); return }
        if started { player.play() }
    }

    func pause() { FrameMonitor.shared.measure("unit.pause") { pauseNow() } }

    private func pauseNow() {
        if wantsPlay { pausedAt = CACurrentMediaTime() }
        scrubHold = false
        playback.pause()
        startPending = false
        if holdsPausedMedia || staged != nil { Neighbours.changed() }
        // Left behind by a scroll: the viewer has muted it, and it stops when the document
        // rests. Any other pause (the user's, the background) stops it now.
        if Neighbours.documentMoving(document), decoder != nil || player.currentItem != nil {
            if !pausePending { pausePending = true; deferredAt = CACurrentMediaTime() }
            return
        }
        pauseMedia()
    }

    private func pauseMedia() {
        pausePending = false
        decoder?.pause()
        player.currentItem?.preferredForwardBufferDuration = playbackPolicy.forwardBuffer(playing: false)
        player.pause()
    }

    // Back in the foreground (or online again): a failed item reloads; a live stream rejoins its
    // live edge; anything else simply plays on.
    func resume(liveEdge: Bool) {
        guard video != nil else { return }
        if !wantsPlay { playRequestedAt = CACurrentMediaTime(); playStartedMs = nil }
        guard playback.play() else { return }
        pausePending = false
        startPending = false
        if staged != nil { beginStagedMedia(); return }
        if let decoder { decoder.play(); return }
        player.currentItem?.preferredForwardBufferDuration = playbackPolicy.forwardBuffer(playing: true)
        if resolving { return }
        if player.currentItem == nil || player.currentItem?.status == .failed { reload(); return }
        if liveEdge, timeline.snapshot().isLive, let end = player.currentItem?.seekableTimeRanges.last?.timeRangeValue.end {
            player.seek(to: end)
        }
        if started { player.play() }
    }

    func snapshot() -> TimelineSnapshot {
        if let decoder {
            return TimelineSnapshot(currentTime: decoder.currentTime, duration: decoder.duration, seekMax: decoder.duration, seekableEnd: decoder.duration)
        }
        observe()
        return timeline.snapshot()
    }

    // PlayerUnit.seek: `resume` pauses, seeks and plays on unless that would be at the very end.
    func seek(_ time: Double, resume: Bool) {
        let snapshot = snapshot()
        guard snapshot.seekMax > 0 else { return }
        if !seekGestureOpen { seekOrigin = snapshot.currentTime; seekLanding = nil; seekGestureOpen = true }
        let terminal = (snapshot.seekableEnd ?? 0) > 0 ? min(snapshot.seekableEnd!, snapshot.seekMax) : snapshot.seekMax
        var target = max(0, min(time, snapshot.seekMax))
        let shouldResume = resume && (snapshot.isLive || target < terminal - 0.1)
        if !shouldResume && target >= terminal - 0.1 { target = max(0, terminal - 0.1) }
        let seekAction = playback.seek(resume: resume ? shouldResume : nil, beforeEnd: target < terminal - 0.1)
        if let decoder {
            if decoder.reachedEnd, let video {
                // A completed native input must reopen at the requested position;
                // sending a seek to the stopped input would be ignored.
                self.video = nil
                load(video, start: target, play: shouldResume)
                return
            }
            decoder.seek(target)
            if shouldResume { decoder.play() }
            else if resume { decoder.pause() }
            if resume { seekGestureOpen = false }
            emitTime()
            return
        }
        // A drag shows stills: playing on between its seeks would restart buffering and sound
        // for every touch sample. The finger lifting (play) continues from the last still.
        scrubHold = !resume
        player.pause()
        // A drag's first touch samples carry no movement: the picture showing is the one asked for.
        if !resume, seekState.target == nil, let seekOrigin, abs(target - seekOrigin) < 0.25 || showsLanding(for: target) { return }
        seek(to: target) { [weak self] in
            guard let self, resume else { return }
            // A jump is one gesture; a drag keeps its origin until the finger lifts (play).
            self.seekGestureOpen = false
            guard shouldResume, self.playback.mayResumeSeek(seekAction) else { return }
            self.player.play()
        }
        emitTime()
    }

    // One seek in flight, chasing the newest target (Apple QA1820), so scrubbing stays smooth.
    private func seek(to seconds: Double, then done: (() -> Void)? = nil) {
        if seekRequestedAt == nil { seekRequestedAt = CACurrentMediaTime() }
        seekState.request(CMTime(seconds: seconds, preferredTimescale: 600).seconds)
        if let done { seekDone.append(done) }
        if !seeking { chase() }
    }

    // The landing a forward seek shows is the nearest keyframe not before the origin; a
    // backward one, the keyframe at or before the target. While the target stays between the
    // origin and the last landing, the same keyframe would be shown again.
    private func showsLanding(for target: Double) -> Bool {
        guard seekGestureOpen, let origin = seekOrigin, let landing = seekLanding else { return false }
        return target > origin ? landing >= target && landing >= origin : landing <= target && landing <= origin
    }

    private func chase() {
        guard let request = seekState.begin() else { return }
        if showsLanding(for: request.target) { seekFinished(request); return }
        let mediaGeneration = token
        // A keyframe shows at once; an exact landing decodes every picture from the keyframe
        // before it (up to seven seconds of 4K here). Backward, the keyframe at or before the
        // target. Forward, the nearest keyframe that is not before the gesture's origin, so a
        // drag never shows an earlier picture than the one it started from.
        let origin = seekOrigin ?? request.target
        let forward = request.target > origin
        let before = forward ? CMTime(seconds: request.target - origin, preferredTimescale: 600) : CMTime.positiveInfinity
        let after = forward ? CMTime.positiveInfinity : CMTime.zero
        player.seek(to: CMTime(seconds: request.target, preferredTimescale: 600), toleranceBefore: before, toleranceAfter: after) { [weak self] finished in
            MainActor.assumeIsolated {
                guard let self, self.token == mediaGeneration else { return }
                guard finished else {
                    self.seekState.rejected(request)
                    self.scheduleRecovery()
                    return
                }
                self.completedSeeks += 1
                let landed = self.player.currentTime().seconds
                if landed.isFinite { self.seekLanding = landed }
                self.seekFinished(request)
            }
        }
    }

    private func seekFinished(_ request: ChasingSeek.Request) {
        switch seekState.complete(request) {
        case .ignored: return
        case .retry: chase()
        case .settled:
            if let started = seekRequestedAt {
                seekEvidence = ["seeks": (seekEvidence["seeks"] as? Int ?? 0) + 1, "lastSeekTarget": request.target,
                                "lastSeekMs": (CACurrentMediaTime() - started) * 1000, "lastSeekLanded": player.currentTime().seconds]
                seekRequestedAt = nil
            }
            let done = seekDone; seekDone = []
            done.forEach { $0() }
        }
    }

    private func currentSeconds() -> Double {
        if let decoder { return decoder.currentTime }
        if let target = seekState.target { return target }
        // A reused preview may leave the visible range before its saved seek can start.
        // Its temporary zero is not a new playback position.
        if !started { return startTime }
        let seconds = player.currentTime().seconds
        return seconds.isFinite ? seconds : 0
    }

    private func observe() { timeline.observe(player, current: currentSeconds()) }

    // Playing with a picture on screen: the request has become playback.
    private func notePlaybackStarted() {
        guard decoder == nil, playStartedMs == nil, let requested = playRequestedAt,
              player.timeControlStatus == .playing, view.playerLayer.isReadyForDisplay else { return }
        playStartedMs = (CACurrentMediaTime() - requested) * 1000
    }

    private func timeUpdate() {
        notePlaybackStarted()
        updatePoster()
        if let decoder {
            if decoder.reachedEnd { playback.end() }
            if decoder.playing { failures = 0; recovery?.invalidate(); recovery = nil }
            if decoder.size != .zero && decoder.size != presentationSize {
                presentationSize = decoder.size
                delegate?.unitGeometryChanged(self)
            }
            if decoder.playing, decoder.hasPicture, let requested = playRequestedAt, playStartedMs == nil {
                playStartedMs = (CACurrentMediaTime() - requested) * 1000
            }
        }
        let now = CACurrentMediaTime()
        guard now - lastTimeEmit >= 0.25 else { return }
        lastTimeEmit = now
        emitTime()
    }

    private func emitTime() {
        delegate?.unitTime(self, snapshot())
    }

    // PC recordings: the playlist's own timeline (segment names for editing, live until ENDLIST).
    private func refreshPlaylist(_ video: ViewerVideo, token: Int) {
        guard playlistTask == nil, let url = video.media?.url else { return }
        playlistRefresh?.invalidate()
        playlistRefresh = nil
        playlistTask = Task { [weak self] in
            defer { if let self, token == self.token { self.playlistTask = nil } }
            do {
                let playlist = try await Playlist.fetch(url)
                guard let self, token == self.token else { return }
                timeline.playlist = playlist
                emitTime()
                if video.isLive != playlist.isLive { delegate?.unitLiveChanged(self, playlist.isLive) }
                if playlist.isLive && timeline.mediaDuration != nil { schedulePlaylist(video, token: token) }
            } catch {
                print("Playlist authority fetch failed:", error.localizedDescription)
                guard let self, token == self.token, timeline.mediaDuration != nil, timeline.snapshot().isLive else { return }
                schedulePlaylist(video, token: token)
            }
        }
    }

    private func schedulePlaylist(_ video: ViewerVideo, token: Int) {
        playlistRefresh?.invalidate()
        playlistRefresh = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshPlaylist(video, token: token) }
        }
    }

    // A recording that finalizes while it plays turns finite before the PC's playlist says so.
    private func reconcileFinalization() {
        guard let video, video.local else { return }
        observe()
        guard timeline.mediaDuration != nil, timeline.snapshot().isLive else { return }
        refreshPlaylist(video, token: token)
    }

    var playlist: Playlist? { timeline.playlist }

    var playbackEvidence: [String: Any] {
        if let decoder {
            return decoder.evidence.merging(["video": video?.filename ?? "", "videoCodec": video?.videoCodec ?? "unknown",
                                              "wantsPlay": wantsPlay, "activationMs": playStartedMs ?? -1]) { _, new in new }
        }
        // The access log waits for the item; it is read only once the item plays.
        let item = player.currentItem, log = started && !seeking && item?.status == .readyToPlay ? item?.accessLog()?.events.last : nil
        let finite = { (value: Double) in value.isFinite ? value : 0 }
        let end = item?.loadedTimeRanges.last?.timeRangeValue.end.seconds ?? 0
        return ["video": video?.filename ?? "", "wantsPlay": wantsPlay, "rate": Double(player.rate),
                "status": player.timeControlStatus.rawValue, "waiting": player.reasonForWaitingToPlay?.rawValue ?? "",
                "width": finite(Double(presentationSize.width)), "height": finite(Double(presentationSize.height)),
                "bufferAheadSeconds": max(0, finite(end - player.currentTime().seconds)),
                "preferredBufferSeconds": item?.preferredForwardBufferDuration ?? 0,
                "activationMs": playStartedMs ?? -1, "bytesTransferred": log?.numberOfBytesTransferred ?? 0,
                "observedMbps": finite(log?.observedBitrate ?? 0) / 1_000_000,
                "stalls": log?.numberOfStalls ?? 0,
                "droppedVideoFrames": log?.numberOfDroppedVideoFrames ?? 0].merging(seekEvidence) { _, new in new }
    }

    #if ORIGINAL_CODEC_PROBE
    func beginDecoderDiagnostics(at url: URL) -> Bool {
        #if canImport(VLCKit)
        guard let decoder = decoder as? VLCVideoDecoder else { return false }
        decoder.beginDiagnostics(at: url)
        return true
        #else
        return false
        #endif
    }
    #endif

    private func clearMedia() {
        playback.clear()
        decoderLoadTask?.cancel()
        decoderLoadTask = nil
        decoder?.stop()
        decoder = nil
        decoderSurface?.removeFromSuperview()
        decoderSurface = nil
        playlistRefresh?.invalidate()
        playlistRefresh = nil
        playlistTask?.cancel()
        playlistTask = nil
        recovery?.invalidate()
        recovery = nil
        pictureCheck?.invalidate()
        pictureCheck = nil
        playback.resolved()
        observations = []
        notifications.forEach(NotificationCenter.default.removeObserver)
        notifications = []
        seekState.cancel()
        seekDone = []
        seekRequestedAt = nil
        seekEvidence = ["seeks": 0]
        seekOrigin = nil
        seekLanding = nil
        seekGestureOpen = false
        scrubHold = false
        staged = nil
        pausePending = false
        startPending = false
        posterView.image = nil
        posterView.isHidden = true
        if player.currentItem != nil {
            player.pause()
            player.replaceCurrentItem(with: nil)
        }
        if presentationSize != .zero {
            presentationSize = .zero
            delegate?.unitGeometryChanged(self)
        }
    }
}

// Only the video being watched holds a player. This keeps the others cheap: it gives up the
// players of neighbours left behind (all but the last one watched, for a quick return) and
// reads the stills of neighbours that have none yet, one at a time, nearest the screen
// first, and never while the watched video is still starting.
@MainActor
private enum Neighbours {
    static let units = NSHashTable<ViewerUnit>.weakObjects()
    private static var timer: Timer?
    private static var reading = false

    private static var offset: CGFloat = 0
    private static var scrolledAt: CFTimeInterval = 0

    static func noteScroll(_ document: UIScrollView?) {
        guard let y = document?.contentOffset.y, y != offset else { return }
        offset = y
        scrolledAt = CACurrentMediaTime()
    }

    // A finger or momentum moves it, or it moved within the last few frames.
    static func documentMoving(_ document: UIScrollView?) -> Bool {
        noteScroll(document)
        guard let document else { return false }
        return document.isDragging || document.isDecelerating || CACurrentMediaTime() - scrolledAt < 0.06
    }

    static func changed() {
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 0.05, repeats: true) { _ in MainActor.assumeIsolated { pump() } }
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private static func pump() {
        let all = units.allObjects
        // What a scroll put off: once the document rests, or after 0.6 s of a slow drag.
        let deferred = all.filter(\.hasDeferredWork)
        if !deferred.isEmpty {
            let now = CACurrentMediaTime()
            for unit in deferred where !documentMoving(unit.document) || now - unit.deferredSince > 0.6 { unit.runDeferred() }
        }
        let starting = all.contains(where: \.isStarting)
        // A paused player is only given up while another video is being watched, never the
        // one the user paused; and not before it has been still for a moment.
        if all.contains(where: \.wantsPlay), !starting {
            let now = CACurrentMediaTime()
            let paused = all.filter(\.holdsPausedMedia).sorted { $0.pausedSince > $1.pausedSince }
            for unit in paused.dropFirst() where now - unit.pausedSince > 1 { unit.releaseMedia() }
        }
        let waiting = all.filter(\.needsPoster)
        if !reading, !starting, let next = waiting.min(by: { $0.viewportDistance < $1.viewportDistance }) {
            reading = true
            Task {
                await next.makePoster()
                reading = false
            }
        }
        if waiting.isEmpty, !reading, all.filter(\.holdsPausedMedia).count <= 1, !all.contains(where: \.hasDeferredWork) {
            timer?.invalidate(); timer = nil
        }
    }
}

struct TimelineSnapshot {
    var currentTime: Double = 0
    var duration: Double = 0
    var seekMax: Double = 0
    var isLive = false
    var seekableEnd: Double?
    var currentSegmentName: String?
}

// packages/app src/player/PlaybackTimeline.ts: the media's clock with the PC playlist's truth.
struct Timeline {
    var playlist: Playlist?
    private var currentTime: Double = 0
    private(set) var mediaDuration: Double?
    private var seekableEnd: Double?
    private var mediaIsLive = false

    mutating func observe(_ player: AVPlayer, current: Double? = nil) {
        let item = player.currentItem
        let seconds = current ?? player.currentTime().seconds
        currentTime = seconds.isFinite ? seconds : 0
        let duration = item?.duration.seconds ?? .nan
        mediaDuration = duration.isFinite && duration > 0 ? duration : nil
        seekableEnd = item?.seekableTimeRanges.last.map { $0.timeRangeValue.end.seconds }.flatMap { $0.isFinite ? $0 : nil }
        mediaIsLive = item?.status == .readyToPlay && item?.duration.isIndefinite == true
    }

    func snapshot() -> TimelineSnapshot {
        if playlist?.isLive ?? mediaIsLive {
            return TimelineSnapshot(currentTime: currentTime, duration: .infinity, seekMax: seekableEnd ?? mediaDuration ?? 0,
                                    isLive: true, seekableEnd: seekableEnd, currentSegmentName: nil)
        }
        let playlistDuration = playlist?.totalDuration ?? 0
        let duration = playlistDuration > 0 ? playlistDuration : (seekableEnd ?? 0) > 0 ? seekableEnd! : mediaDuration ?? 0
        let playlistTime: Double? = playlistDuration > 0 && duration > 0
            ? max(0, min(currentTime * (playlistDuration / duration), playlistDuration)) : nil
        return TimelineSnapshot(currentTime: currentTime, duration: duration, seekMax: duration, isLive: false,
                                seekableEnd: seekableEnd, currentSegmentName: playlistTime.flatMap { playlist?.segment(at: $0)?.name })
    }

    func clamp(_ time: Double) -> Double { max(0, min(time, snapshot().seekMax)) }
}

// A PC recording's playlist (packages/app src/services/hls.ts), fetched every time: a cache
// could freeze a live recording as VOD.
struct Playlist {
    struct Segment { let name: String; let start: Double; let end: Double }
    let segments: [Segment]
    let isLive: Bool
    var totalDuration: Double { segments.last?.end ?? 0 }

    static func fetch(_ url: URL) async throws -> Playlist {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = "GET"
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return parse(String(decoding: data, as: UTF8.self))
    }

    static func parse(_ text: String) -> Playlist {
        let lines = text.components(separatedBy: "\n")
        var segments: [Segment] = []
        var elapsed = 0.0
        for (index, line) in lines.enumerated() where line.hasPrefix("#EXTINF:") {
            let value = line.dropFirst("#EXTINF:".count).prefix { $0.isNumber || $0 == "." }
            guard let duration = Double(value), index + 1 < lines.count else { continue }
            let name = lines[index + 1].trimmingCharacters(in: .whitespaces)
            guard name.hasSuffix(".ts") else { continue }
            segments.append(Segment(name: name, start: elapsed, end: elapsed + duration))
            elapsed += duration
        }
        return Playlist(segments: segments, isLive: !text.contains("#EXT-X-ENDLIST"))
    }

    func segment(at time: Double) -> Segment? {
        guard !segments.isEmpty else { return nil }
        if time >= totalDuration { return segments.last }
        var low = 0, high = segments.count - 1
        while low <= high {
            let middle = (low + high) / 2
            if time < segments[middle].start { high = middle - 1 }
            else if time >= segments[middle].end { low = middle + 1 }
            else { return segments[middle] }
        }
        return nil
    }

    // calculateSegmentsToKeep: the segments the markers' pairs cover, scaled to the playlist.
    func keep(markers: [Double], playbackDuration: Double) -> [String] {
        let scale = playbackDuration > 0 && totalDuration > 0 ? totalDuration / playbackDuration : 1
        var keep: [String] = []
        var seen = Set<String>()
        for index in stride(from: 0, to: markers.count - 1, by: 2) {
            let start = markers[index] * scale, end = markers[index + 1] * scale
            for segment in segments where segment.start < end && segment.end > start && seen.insert(segment.name).inserted {
                keep.append(segment.name)
            }
        }
        return keep
    }
}
