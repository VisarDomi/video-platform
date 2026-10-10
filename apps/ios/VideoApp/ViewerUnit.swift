import AVFoundation
import UIKit

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
    // Whether this unit should be playing (all three play; the app pauses its neighbours in the background).
    private(set) var wantsPlay = false

    private var timeline = Timeline()
    private var token = 0
    private var resolving = false
    private var playerObservations: [NSKeyValueObservation] = []
    private var observations: [NSKeyValueObservation] = []
    private var notifications: [NSObjectProtocol] = []
    private var timeObserver: Any?
    private var lastTimeEmit: CFTimeInterval = 0
    private var startTime: Double = 0
    private var started = false
    private var playlistTask: Task<Void, Never>?
    private var playlistRefresh: Timer?
    private var recovery: Timer?
    private var failures = 0
    private var seekTarget: CMTime?
    private var seeking = false
    private var seekDone: [() -> Void] = []
    private var pictureCheck: Timer?

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
    }

    var muted: Bool {
        get { player.isMuted }
        set { player.isMuted = newValue }
    }

    var hasMedia: Bool { video != nil && !view.isHidden }

    func load(_ video: ViewerVideo, start: Double, play: Bool) {
        if let current = self.video, current.same(video), player.currentItem != nil {
            self.video = video
            play ? self.play() : pause()
            return
        }
        token += 1
        let token = token
        clearMedia()
        self.video = video
        timeline = Timeline()
        startTime = start
        started = false
        wantsPlay = play
        failures = 0
        view.isHidden = false
        resolving = true
        Task { [weak self] in
            guard let self, let delegate else { return }
            do {
                let source = try await delegate.unitSource(video)
                guard token == self.token else { return }
                let asset = await delegate.unitAsset(source, for: video)
                guard token == self.token else { return }
                resolving = false
                attach(AVPlayerItem(asset: asset), token: token)
                if video.local { refreshPlaylist(video, token: token) }
            } catch {
                guard token == self.token else { return }
                resolving = false
                if case ViewerBridge.Failure.authentication = error { delegate.unitNeedsLogin(self) }
                else if video.liveStream { delegate.unitUnavailable(self) }
                else { print("Video source resolution failed:", error.localizedDescription); scheduleRecovery() }
            }
        }
    }

    private func attach(_ item: AVPlayerItem, token: Int) {
        item.preferredForwardBufferDuration = 0
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
                guard let self, token == self.token, self.wantsPlay else { return }
                self.player.play()
            }
        })
        player.replaceCurrentItem(with: item)
        // Nothing to seek to: play at once, as the web unit did before its metadata arrived.
        if startTime <= 0 || video?.liveStream == true { started = true; if wantsPlay { player.play() } }
    }

    private func statusChanged(_ item: AVPlayerItem, token: Int) {
        guard token == self.token else { return }
        switch item.status {
        case .readyToPlay:
            failures = 0
            timeline.observe(player)
            if !started {
                started = true
                let snapshot = timeline.snapshot()
                if startTime > 0 && !snapshot.isLive {
                    seek(to: timeline.clamp(startTime)) { [weak self] in if let self, self.wantsPlay { self.player.play() } }
                } else if wantsPlay { player.play() }
            }
            emitTime()
        case .failed:
            print("Video item failed:", item.error?.localizedDescription ?? "unknown")
            failed(token: token)
        default:
            break
        }
    }

    private func failed(token: Int) {
        guard token == self.token else { return }
        if video?.liveStream == true { delegate?.unitUnavailable(self); return }
        scheduleRecovery()
    }

    // A live stream ends when its playlist does; recordings stop at their end.
    private func ended(token: Int) {
        guard token == self.token else { return }
        emitTime()
        reconcileFinalization()
        if video?.liveStream == true { delegate?.unitUnavailable(self) }
    }

    // As in Stream Viewer: a live stream that "plays" without any picture has ended.
    private func timeControlChanged() {
        pictureCheck?.invalidate()
        pictureCheck = nil
        guard video?.liveStream == true, player.timeControlStatus == .playing else { return }
        let token = token
        pictureCheck = Timer.scheduledTimer(withTimeInterval: 3, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, token == self.token, self.player.timeControlStatus == .playing,
                      self.player.currentItem?.presentationSize == .zero else { return }
                self.delegate?.unitUnavailable(self)
            }
        }
    }

    // Reload at the same position, backing off to 30 s; the video carries on once it can.
    private func scheduleRecovery() {
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
        token += 1
        clearMedia()
        video = nil
        timeline = Timeline()
        wantsPlay = false
        view.isHidden = true
    }

    func update(_ video: ViewerVideo) { self.video = video }

    func play() {
        wantsPlay = true
        if let item = player.currentItem, item.status == .failed { reload(); return }
        if player.currentItem == nil, video != nil, recovery == nil, !resolving { reload(); return }
        if started { player.play() }
    }

    func pause() {
        wantsPlay = false
        player.pause()
    }

    // Back in the foreground (or online again): a failed item reloads; a live stream rejoins its
    // live edge; anything else simply plays on.
    func resume(liveEdge: Bool) {
        guard video != nil else { return }
        wantsPlay = true
        if resolving { return }
        if player.currentItem == nil || player.currentItem?.status == .failed { reload(); return }
        if liveEdge, timeline.snapshot().isLive, let end = player.currentItem?.seekableTimeRanges.last?.timeRangeValue.end {
            player.seek(to: end)
        }
        if started { player.play() }
    }

    func snapshot() -> TimelineSnapshot {
        observe()
        return timeline.snapshot()
    }

    // PlayerUnit.seek: `resume` pauses, seeks and plays on unless that would be at the very end.
    func seek(_ time: Double, resume: Bool) {
        let snapshot = snapshot()
        guard snapshot.seekMax > 0 else { return }
        let terminal = (snapshot.seekableEnd ?? 0) > 0 ? min(snapshot.seekableEnd!, snapshot.seekMax) : snapshot.seekMax
        var target = max(0, min(time, snapshot.seekMax))
        let shouldResume = resume && (snapshot.isLive || target < terminal - 0.1)
        if !shouldResume && target >= terminal - 0.1 { target = max(0, terminal - 0.1) }
        if resume { player.pause() }
        seek(to: target) { [weak self] in
            guard let self, shouldResume, resume else { return }
            self.wantsPlay = true
            self.player.play()
        }
        emitTime()
    }

    // One seek in flight, chasing the newest target (Apple QA1820), so scrubbing stays smooth.
    private func seek(to seconds: Double, then done: (() -> Void)? = nil) {
        seekTarget = CMTime(seconds: seconds, preferredTimescale: 600)
        if let done { seekDone.append(done) }
        if !seeking { chase() }
    }

    private func chase() {
        guard let target = seekTarget else { return }
        seeking = true
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.seekTarget != target { self.chase(); return }
                self.seeking = false
                self.seekTarget = nil
                let done = self.seekDone
                self.seekDone = []
                done.forEach { $0() }
            }
        }
    }

    private func currentSeconds() -> Double {
        if let seekTarget { return seekTarget.seconds }
        let seconds = player.currentTime().seconds
        return seconds.isFinite ? seconds : 0
    }

    private func observe() { timeline.observe(player, current: currentSeconds()) }

    private func timeUpdate() {
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

    private func clearMedia() {
        playlistRefresh?.invalidate()
        playlistRefresh = nil
        playlistTask?.cancel()
        playlistTask = nil
        recovery?.invalidate()
        recovery = nil
        pictureCheck?.invalidate()
        pictureCheck = nil
        resolving = false
        observations = []
        notifications.forEach(NotificationCenter.default.removeObserver)
        notifications = []
        seekTarget = nil
        seeking = false
        seekDone = []
        player.pause()
        player.replaceCurrentItem(with: nil)
        if presentationSize != .zero {
            presentationSize = .zero
            delegate?.unitGeometryChanged(self)
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
