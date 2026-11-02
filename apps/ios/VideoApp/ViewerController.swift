import AVFoundation
import UIKit
import UIKit.UIGestureRecognizerSubclass
import KitCore

// A continuous, aspect-fitted video document. Players are reused around the visible range;
// loading, changing the active player and lifting a finger never reposition the document.
//
// Gestures: a vertical swipe moves through the list, a horizontal drag in the upper half seeks
// (60 s per screen width), one in the lower half shows (rightward) or hides (leftward) the
// controls, the left edge goes back to the list, and a pinch zooms the current video. While
// zoomed the list stays put and the left edge is no way back: drags pan the picture as in
// Safari, except the upper half's horizontal seek, which then starts anywhere, edge included.
// Zoomed back out, swipes move through the list again.
//
// Videos keep playing through lock and the background until they end; nothing pauses, reloads
// or repositions on the way back.
@MainActor
final class ViewerController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate,
                              ViewerUnitDelegate, ViewerOverlayActions {
    private static let edgeWidth: CGFloat = 28
    private static let seekSecondsPerWidth: CGFloat = 60

    let provider: String
    var onClose: (() -> Void)?
    // Opened by going forward from the list: while it still shows that video, the video being
    // gone (a stream that ended, a recording no longer listed) slides it back to the list
    // instead of moving on to the next one.
    var returnsWhenGone = false
    private let host: ViewerHost
    private let media: ViewerMedia
    private let progress: ProgressStore
    private let checkpoint: CheckpointWriter

    private let feed = FeedScrollView()
    private let viewport = UIView()
    private let content = UIView()
    private let overlay = ViewerOverlay()
    private let message = UILabel()
    private let zoom = ZoomScrollView()
    private let session = ViewerSession()
    private var units: [ViewerUnit] = []
    private var activeUnit: ViewerUnit!
    private var geometry = VideoFeedLayout(viewport: .zero, aspects: [])
    private var geometryKeys: [String] = []
    private var indexes: [String: Int] = [:]
    private var measuredSizes: [String: CGSize] = [:]
    private var reservedAspects: [String: CGSize] = [:]
    private var loadingUnits = false
    private var geometryDirty = true
    private var initialPositionApplied = false
    var restoredTop: CGFloat?
    #if targetEnvironment(simulator)
    func configureNavigationCheck(image: UIImage) { fixtureImage = image }
    private var capturedMutationCheck: ViewerVideo?
    func captureMutationCheck() { capturedMutationCheck = currentVideo }
    func completeMutationCheck(type: String) {
        guard let previous = capturedMutationCheck ?? currentVideo else { return }
        capturedMutationCheck = nil
        replaceCurrent(previous.setting("type", type), replacing: previous)
    }

    private var fixtureImage: UIImage?
    private var fixtureLateMetadata = false
    #endif
    private var videos: [ViewerVideo]
    private var currentIndex: Int
    private var segments: [Double] = []
    private var controlsVisible = true
    private var unsettled = false
    private var programmatic = false
    private var touching = false
    private var lastProgressSave: CFTimeInterval = 0
    private var lastNowPlaying: CFTimeInterval = 0
    private var discovered = Set<String>()
    private var removed = Set<String>()
    private var revealed = false
    private var revealTimer: Timer?
    private var zoomed = false
    private var seekPan: UIPanGestureRecognizer!
    private var edgePan: UIScreenEdgePanGestureRecognizer!
    private var seekBase: Double = 0
    private var seeking = false
    private var observers: [NSObjectProtocol] = []
    private var lastBounds: CGSize = .zero
    private var closed = false
    // Restoring after a relaunch: the last picture over the feed until the player has its own.
    var restoring = false
    private var poster: UIImageView?
    private var posterReady: NSKeyValueObservation?

    // Built ahead, while nothing on screen moves (the list keeps one ready): its views, players
    // and gestures take 10-20 ms of the main thread, which a tap would otherwise lose as a
    // frame. `open` starts it.
    init(provider: String, host: ViewerHost, media: ViewerMedia, progress: ProgressStore, checkpoint: CheckpointWriter) {
        self.provider = provider
        videos = []
        currentIndex = 0
        self.host = host
        self.media = media
        self.progress = progress
        self.checkpoint = checkpoint
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    var currentVideo: ViewerVideo? { videos.indices.contains(currentIndex) ? videos[currentIndex] : active.video }
    private var active: ViewerUnit { activeUnit }
    private var live: Bool { currentVideo?.liveStream ?? false }
    private var inBackground: Bool { UIApplication.shared.applicationState == .background }
    private var playbackPolicy: ViewerPlaybackPolicy { ViewerPlaybackPolicy(provider: provider) }
    private var lastPlaybackEvidence: CFTimeInterval = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        view.clipsToBounds = false
        view.layer.shadowColor = UIColor.black.cgColor
        view.layer.shadowRadius = 10
        feed.delegate = self
        feed.backgroundColor = .black
        feed.showsVerticalScrollIndicator = false
        feed.showsHorizontalScrollIndicator = false
        feed.contentInsetAdjustmentBehavior = .never
        feed.alwaysBounceVertical = true
        feed.scrollsToTop = false
        feed.alpha = 0
        feed.addSubview(content)
        units = FrameMonitor.shared.measure("open.units") {
            (0..<3).map { _ in
                let unit = ViewerUnit()
                unit.delegate = self
                content.addSubview(unit.view)
                return unit
            }
        }

        activeUnit = units[1]

        zoom.delegate = self
        zoom.backgroundColor = .black
        zoom.minimumZoomScale = 1
        zoom.maximumZoomScale = 5
        zoom.showsVerticalScrollIndicator = false
        zoom.showsHorizontalScrollIndicator = false
        zoom.contentInsetAdjustmentBehavior = .never
        zoom.scrollsToTop = false
        // Zoom the existing viewport, including its original player layers. Switching to
        // another AVPlayerLayer at the first pinch needs a new first frame and can flash.
        viewport.backgroundColor = .black
        viewport.addSubview(feed)
        zoom.addSubview(viewport)
        zoom.isActive = { [weak self] in self?.zoomed ?? false }
        view.addSubview(zoom)
        feed.panGestureRecognizer.maximumNumberOfTouches = 1

        message.textColor = UIColor(white: 0.67, alpha: 1)
        message.textAlignment = .center
        message.numberOfLines = 0
        message.isHidden = true
        view.addSubview(message)
        overlay.actions = self
        view.addSubview(overlay)

        edgePan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(edgePanned(_:)))
        edgePan.edges = .left
        edgePan.delegate = self
        view.addGestureRecognizer(edgePan)
        seekPan = UIPanGestureRecognizer(target: self, action: #selector(seekPanned(_:)))
        seekPan.delegate = self
        seekPan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(seekPan)
        let contact = ContactRecognizer { [weak self] down in
            guard let self else { return }
            touching = down
            if !down { DispatchQueue.main.async { [weak self] in self?.settle() } }
        }
        contact.delegate = self
        view.addGestureRecognizer(contact)
        for pan in [feed.panGestureRecognizer, zoom.panGestureRecognizer, seekPan!] { pan.require(toFail: edgePan) }
        feed.shouldPan = { [weak self] _ in self?.zoomed == false }
        zoom.shouldPan = { [weak self] start, translation in
            guard let self else { return true }
            return !(abs(translation.x) > abs(translation.y) && start.y < self.view.bounds.height / 2)
        }

    }

    // The list's videos from `index`: the session begins and the selected video loads.
    func open(videos: [ViewerVideo], index: Int) {
        loadViewIfNeeded()
        self.videos = videos
        indexes = Dictionary(uniqueKeysWithValues: videos.enumerated().map { ($0.element.key, $0.offset) })
        geometryDirty = true
        currentIndex = index
        #if targetEnvironment(simulator)
        if fixtureImage == nil { FrameMonitor.shared.measure("open.session") { beginSession() } }
        #else
        FrameMonitor.shared.measure("open.session") { beginSession() }
        #endif
        UIApplication.shared.isIdleTimerDisabled = true
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.enteredBackground() }
            },
            center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.enteringForeground() }
            },
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
                let ended = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.ended.rawValue
                MainActor.assumeIsolated { if ended { self?.interruptionEnded() } }
            },
        ]

        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.savePoster() }
        })

        // The selected video gets the network first; its neighbours load once it has a picture.
        FrameMonitor.shared.measure("open.load") { loadFirst() }
    }

    private func loadFirst() {
        guard let video = currentVideo else { return }
        if restoring { showPoster(for: video) }
        overlay.setVideo(video)
        overlay.setUiVisible(controlsVisible)
        overlay.setMuted(true)
        // The saved time at once (not 0:00 until the player reports it).
        let start = savedTime(video), duration = (video.raw["duration"] as? NSNumber)?.doubleValue ?? 0
        if !video.liveStream && duration > 0 { overlay.setTimeline(TimelineSnapshot(currentTime: start, duration: duration, seekMax: duration)) }
        #if targetEnvironment(simulator)
        if let fixtureImage {
            active.configureZoomCheck(video: video, size: aspect(of: video), image: fixtureImage)
            reveal()
            return
        }
        #endif
        active.load(video, start: start, play: true)
        revealTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.reveal() }
        }
    }

    private func beginSession() {
        session.begin(.init(
            play: { [weak self] in self?.active.play() },
            pause: { [weak self] in self?.active.pause() },
            toggle: { [weak self] in
                guard let self else { return }
                active.wantsPlay ? active.pause() : active.play()
            },
            step: { [weak self] direction in self?.step(direction) },
            seek: { [weak self] time in
                guard let self, !self.live else { return }
                self.active.seek(time, resume: true)
            }))
        session.setAudible(false)
        media.start()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        if zoom.frame != view.bounds { zoom.frame = view.bounds }
        overlay.frame = view.bounds
        message.frame = view.bounds.insetBy(dx: 20, dy: 0)
        view.layer.shadowPath = UIBezierPath(rect: view.bounds).cgPath
        guard view.bounds.size != lastBounds else { return }
        var anchor = documentAnchor
        if let saved = anchor, let index = indexes[saved.key], let oldPicture = pictureFrame(at: index), oldPicture.height > 0 {
            let fraction = (feed.bounds.height / 2 - saved.top) / oldPicture.height
            let size = knownAspect(of: videos[index]) ?? view.bounds.size
            let fitted = AVMakeRect(aspectRatio: size, insideRect: view.bounds)
            anchor = (saved.key, view.bounds.height / 2 - fraction * fitted.height)
        }
        reservedAspects.removeAll()
        lastBounds = view.bounds.size
        FrameMonitor.shared.measure("viewer.layout") {
            if zoomed { exitZoom() }
            zoom.setZoomScale(1, animated: false)
            viewport.bounds = CGRect(origin: .zero, size: view.bounds.size)
            viewport.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
            feed.bounds = CGRect(origin: .zero, size: view.bounds.size)
            feed.center = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
            zoom.contentSize = view.bounds.size
            geometryDirty = true
            layoutFeed(anchor: anchor)
            if revealed && !initialPositionApplied { placeInitialVideo() }
        }
    }

    // MARK: the list

    // The page's list changed (packages/app routes/nativeViewer.ts list): videoViewer.ts updateCanonicalList.
    func updateList(_ list: [ViewerVideo]) {
        FrameMonitor.shared.measure("viewer.list") { updateListNow(list) }
    }

    private func updateListNow(_ list: [ViewerVideo]) {
        guard !closed, !list.isEmpty || live else { return }
        let current = active.video
        var filtered = (live ? list.filter { !removed.contains($0.filename) } : list).map { video in
            guard let size = measuredSizes[video.key] else { return video }
            return video.setting("viewerWidth", Double(size.width)).setting("viewerHeight", Double(size.height))
        }
        // A live stream that ended before this list arrived: the next one takes its place.
        if let current, live, removed.contains(current.filename) {
            let position = list.firstIndex { $0.filename == current.filename }
            videos = filtered
            showAt(position.map { list[..<$0].filter { !removed.contains($0.filename) }.count } ?? 0)
            host.remove(current.filename)
            return
        }
        guard let current else { return }
        let matching = filtered.filter { $0.sameRecording(current) }
        guard let index = filtered.firstIndex(where: { $0.same(current) })
                ?? filtered.firstIndex(where: { $0.pageUrl != nil && $0.pageUrl == current.pageUrl })
                ?? (matching.count == 1 ? filtered.firstIndex(where: { $0.sameRecording(current) }) : nil) else {
            if returnsWhenGone { slideAway() }
            return
        }
        var anchor = documentAnchor
        let updated = filtered[index]
        if anchor?.key == current.key { anchor?.key = updated.key }
        carryGeometry(from: current, to: updated)
        let size = measuredSizes[current.key] ?? active.presentationSize
        if size.width > 0, size.height > 0 {
            measuredSizes[updated.key] = size
            filtered[index] = updated.setting("viewerWidth", Double(size.width)).setting("viewerHeight", Double(size.height))
        }
        videos = filtered
        indexes = Dictionary(uniqueKeysWithValues: videos.enumerated().map { ($0.element.key, $0.offset) })
        geometryDirty = true
        currentIndex = index
        if current.progressKey != filtered[index].progressKey, current.size == filtered[index].size {
            progress.migrate(from: current.progressKey, to: filtered[index].progressKey)
        }
        if current.type != updated.type {
            for unit in units where unit !== active && unit.video?.sameRecording(current) == true { unit.clear() }
            progress.set(updated.progressKey, 0)
            loadVariant(filtered[index], in: active, play: active.wantsPlay)
        }
        else { active.update(filtered[index]) }
        layoutFeed(anchor: anchor)
        overlay.setVideo(filtered[index])
        if revealed { loadEdgeUnits() }
    }

    // Opening the video that is already showing (the page restoring its viewer address) changes nothing.
    func shows(_ video: ViewerVideo) -> Bool { currentVideo.map { $0.same(video) } ?? false }

    private func video(at index: Int) -> ViewerVideo? { videos.indices.contains(index) ? videos[index] : nil }

    private func savedTime(_ video: ViewerVideo) -> Double { video.liveStream ? 0 : progress.time(video.progressKey) }

    private func saveProgress() {
        guard let video = currentVideo, !video.liveStream else { return }
        progress.set(video.progressKey, active.snapshot().currentTime)
    }

    private func saveCheckpoint() {
        guard let video = currentVideo else { return }
        let top = pictureFrame(at: currentIndex).map { $0.minY - feed.contentOffset.y }
        checkpoint.save(ViewerCheckpoint(provider: provider, videos: videos, current: video.key, top: top.map(Double.init)))
    }

    private func reveal() {
        guard !revealed, !closed else { return }
        revealed = true
        revealTimer?.invalidate()
        layoutFeed()
        placeInitialVideo()
        // Under a poster the feed shows at once; the poster goes when the player has a picture.
        if poster != nil { feed.alpha = 1; removePosterWhenPlaying() }
        else { UIView.animate(withDuration: 0.12) { self.feed.alpha = 1 } }
        loadEdgeUnits()
        activateCurrent()
    }

    private func loadEdgeUnits() {
        FrameMonitor.shared.measure("viewer.load") { loadEdgeUnitsNow() }
    }

    private func loadEdgeUnitsNow() {
        guard !loadingUnits, !closed, !videos.isEmpty else { return }
        loadingUnits = true
        defer { loadingUnits = false }
        layoutFeed()
        guard let window = geometry.playerWindow(top: feed.contentOffset.y, height: feed.bounds.height, current: currentIndex) else { return }
        let wanted = Set(window)
        let keys = Set(wanted.map { videos[$0].key })
        for index in wanted.sorted(by: { abs($0 - currentIndex) < abs($1 - currentIndex) }) {
            let video = videos[index]
            let unit: ViewerUnit
            if let kept = units.first(where: { $0.video?.same(video) == true }) { unit = kept }
            else if let spare = units.first(where: { $0.video.map { !keys.contains($0.key) } ?? true }) {
                rememberProgress(spare)
                unit = spare
            } else {
                unit = ViewerUnit()
                unit.delegate = self
                if inBackground { unit.setVideoEnabled(false) }
                units.append(unit)
                content.addSubview(unit.view)
            }
            if index == currentIndex { activeUnit = unit }
            if unit.video?.same(video) == true { unit.update(video) }
            else {
                #if targetEnvironment(simulator)
                if let fixtureImage {
                    if fixtureLateMetadata { unit.configurePendingMetadataCheck(video: video) }
                    else { unit.configureZoomCheck(video: video, size: aspect(of: video), image: fixtureImage) }
                } else {
                    unit.load(video, start: savedTime(video), play: playbackPolicy.shouldPlay(position: index == currentIndex ? 1 : 0, inBackground: inBackground))
                }
                #else
                unit.load(video, start: savedTime(video), play: playbackPolicy.shouldPlay(position: index == currentIndex ? 1 : 0, inBackground: inBackground))
                #endif
            }
            if geometry.frames.indices.contains(index) { unit.view.frame = geometry.frames[index] }
        }
        for unit in units where unit.video.map({ !keys.contains($0.key) }) == true {
            rememberProgress(unit)
            unit.clear()
        }
        updateUnitVisibility()
    }

    private func updateUnitVisibility() {
        let revealNeighbours = unsettled && !zoomed
        for unit in units {
            unit.view.isHidden = unit.video == nil || (unit !== active && !revealNeighbours)
        }
    }

    private func rememberProgress(_ unit: ViewerUnit) {
        if let video = unit.video, !video.liveStream { progress.set(video.progressKey, unit.snapshot().currentTime) }
    }

    private func activateCurrent() {
        FrameMonitor.shared.measure("viewer.activate") { activateCurrentNow() }
    }

    private func activateCurrentNow() {
        updateUnitVisibility()
        #if targetEnvironment(simulator)
        if fixtureImage != nil {
            overlay.setVideo(currentVideo)
            overlay.setInteractive(!unsettled)
            if let video = currentVideo { host.highlight(video.filename, reveal: false); saveCheckpoint() }
            return
        }
        #endif
        let monitor = FrameMonitor.shared
        monitor.measure("activate.play") {
            for unit in units where unit.video != nil {
                if unit !== active { unit.muted = true }
                if playbackPolicy.shouldPlay(position: unit === active ? 1 : 0, inBackground: inBackground) { unit.play() }
                else { unit.pause() }
            }
        }
        guard let video = currentVideo else { return }
        monitor.measure("activate.overlay") {
            overlay.setVideo(video)
            overlay.setTimeline(active.snapshot())
            overlay.setMuted(active.muted)
            overlay.setSegments(segments)
            overlay.showMembership(video.membership)
            overlay.setUiVisible(controlsVisible)
            overlay.setInteractive(!unsettled)
        }
        monitor.measure("activate.session") {
            session.setAudible(!active.muted)
            nowPlaying(force: true)
        }
        monitor.measure("activate.list") { host.highlight(video.filename, reveal: false) }
        monitor.measure("activate.save") { saveCheckpoint() }
        discover(video)
    }

    // As in Stream Viewer: once per streamer (not for co-streamers), co-streamers new to the list
    // join at the bottom; existing entries keep their place.
    private func discover(_ video: ViewerVideo) {
        guard video.liveStream, video.parent == nil, !discovered.contains(video.filename) else { return }
        discovered.insert(video.filename)
        Task {
            do {
                let fresh = try await host.related(video).filter { !removed.contains($0.filename) }
                if !fresh.isEmpty && videos.contains(where: { $0.filename == video.filename }) {
                    host.append(fresh)
                }
            } catch {
                discovered.remove(video.filename)
                print("Could not discover co-streamers for \(video.filename):", error.localizedDescription)
            }
        }
    }

    // Streams that end or are blocked leave the list and the next one takes their place.
    private func removeCurrent() {
        guard let video = active.video, !removed.contains(video.filename) else { return }
        removed.insert(video.filename)
        let index = videos.firstIndex { $0.filename == video.filename }
        if let index { videos.remove(at: index) }
        showAt(max(0, index ?? 0))
        host.remove(video.filename)
    }

    private func showAt(_ index: Int) {
        guard !videos.isEmpty else {
            units.forEach { $0.clear() }
            overlay.setVideo(nil)
            message.text = "No live streams are available."
            message.isHidden = false
            return
        }
        message.isHidden = true
        currentIndex = min(index, videos.count - 1)
        geometryDirty = true
        loadEdgeUnits()
        activateCurrent()
    }

    private func replace(_ video: ViewerVideo) {
        if let index = videos.firstIndex(where: { $0.same(video) }) { videos[index] = video }
        for unit in units where unit.video?.same(video) == true { unit.update(video) }
        if currentVideo?.same(video) == true { overlay.setVideo(video) }
    }

    private func carryGeometry(from old: ViewerVideo, to new: ViewerVideo) {
        guard old.key != new.key else { return }
        if let size = reservedAspects[old.key] { reservedAspects[new.key] = size }
        if let size = measuredSizes[old.key] { measuredSizes[new.key] = size }
        if let size = progress.displaySize(old.key) { progress.setDisplaySize(new.key, size) }
    }

    private func loadVariant(_ video: ViewerVideo, in unit: ViewerUnit, play: Bool) {
        #if targetEnvironment(simulator)
        if let fixtureImage { unit.configureZoomCheck(video: video, size: aspect(of: video), image: fixtureImage); return }
        #endif
        unit.load(video, start: 0, play: play)
    }

    // MARK: the feed

    private func knownAspect(of video: ViewerVideo) -> CGSize? {
        if let size = video.displaySize { return size }
        if let size = measuredSizes[video.key] { return size }
        if let size = progress.displaySize(video.key) { return size }
        if let width = video.raw["viewerWidth"] as? Double, let height = video.raw["viewerHeight"] as? Double,
           width.isFinite, height.isFinite, width >= 32, height >= 32 { return CGSize(width: width, height: height) }
        return nil
    }

    private func aspect(of video: ViewerVideo) -> CGSize {
        if let size = reservedAspects[video.key] { return size }
        // Reserve server/known dimensions before playback. An unknown clip gets a full
        // viewport, so every eventual aspect fits without miniature portrait previews.
        // Decoder readiness/quality changes never change a reservation during exploration.
        let size = knownAspect(of: video) ?? feed.bounds.size
        reservedAspects[video.key] = size
        return size
    }

    private func pictureFrame(at index: Int) -> CGRect? {
        guard videos.indices.contains(index), geometry.frames.indices.contains(index) else { return nil }
        let video = videos[index], frame = geometry.frames[index]
        let presentation = units.first(where: { $0.video?.same(video) == true })?.presentationSize ?? .zero
        let size = presentation.width > 0 && presentation.height > 0 ? presentation : knownAspect(of: video) ?? aspect(of: video)
        let inside = AVMakeRect(aspectRatio: size, insideRect: CGRect(origin: .zero, size: frame.size))
        return inside.offsetBy(dx: frame.minX, dy: frame.minY)
    }

    private var documentAnchor: (key: String, top: CGFloat)? {
        guard let index = geometry.index(at: midpoint), geometryKeys.indices.contains(index), let frame = pictureFrame(at: index) else { return nil }
        return (geometryKeys[index], frame.minY - feed.contentOffset.y)
    }

    private func layoutFeed(anchor: (key: String, top: CGFloat)? = nil) {
        guard geometryDirty, feed.bounds.width > 0, feed.bounds.height > 0 else { return }
        let anchor = anchor ?? (initialPositionApplied ? documentAnchor : nil)
        geometryDirty = false
        indexes = Dictionary(uniqueKeysWithValues: videos.enumerated().map { ($0.element.key, $0.offset) })
        geometry = VideoFeedLayout(viewport: feed.bounds.size, aspects: videos.map(aspect))
        geometryKeys = videos.map(\.key)
        programmatic = true
        content.frame = CGRect(origin: .zero, size: geometry.size)
        feed.contentSize = geometry.size
        for unit in units {
            if let key = unit.video?.key, let index = indexes[key] { unit.view.frame = geometry.frames[index] }
        }
        if let anchor, let index = indexes[anchor.key], let frame = pictureFrame(at: index) { setOffset(frame.minY - anchor.top) }
        programmatic = false
    }

    private var midpoint: CGFloat { feed.contentOffset.y + feed.bounds.height / 2 }

    private func setOffset(_ y: CGFloat) {
        guard abs(feed.contentOffset.y - y) > 0.001 else { return }
        let previous = programmatic
        programmatic = true
        feed.contentOffset = CGPoint(x: 0, y: y)
        programmatic = previous
    }

    private func placeInitialVideo() {
        guard !initialPositionApplied, geometry.frames.indices.contains(currentIndex) else { return }
        initialPositionApplied = true
        let frame = geometry.frames[currentIndex]
        setOffset(restoredTop.map { (pictureFrame(at: currentIndex)?.minY ?? frame.minY) - $0 } ?? (frame.midY - feed.bounds.height / 2))
    }

    private func selectVisibleVideo() {
        guard !zoomed, let index = geometry.index(at: midpoint) else { return }
        if index != currentIndex {
            saveProgress()
            currentIndex = index
            returnsWhenGone = false
            segments = []
            loadEdgeUnits()
            activateCurrent()
        } else { loadEdgeUnits() }
    }

    // Idle only commits state and any deferred metadata. It never chooses a landing position.
    private func settle() {
        guard !zoomed, !touching, !feed.isDragging, !feed.isDecelerating, !closed else { return }
        unsettled = false
        selectVisibleVideo()
        overlay.setInteractive(true)
        updateUnitVisibility()
        saveCheckpoint()
    }

    // Explicit lock-screen next/previous is navigation, unlike a free scroll.
    private func step(_ direction: Int) {
        guard !moving, videos.indices.contains(currentIndex + direction) else { return }
        if zoomed { exitZoom() }
        saveProgress()
        currentIndex += direction
        segments = []
        layoutFeed()
        let frame = geometry.frames[currentIndex]
        setOffset(frame.midY - feed.bounds.height / 2)
        loadEdgeUnits()
        activateCurrent()
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        if scrollView === feed {
            // A restoration image must never hold the document still under a moving finger.
            removePoster()
            if !revealed { reveal(); feed.alpha = 1 }
            monitor(true)
            unsettled = true
            overlay.setInteractive(false)
            updateUnitVisibility()
        }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === feed, !programmatic, revealed else { return }
        FrameMonitor.shared.measure("viewer.scroll") { selectVisibleVideo() }
    }

    var moving: Bool { !closed && (unsettled || touching || feed.isTracking || feed.isDragging || feed.isDecelerating) }

    private var monitoring = false
    private func monitor(_ moving: Bool) {
        guard moving != monitoring else { return }
        monitoring = moving
        FrameMonitor.shared.scrolling(moving)
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if scrollView === feed && !decelerate { monitor(false); settle() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        if scrollView === feed { monitor(false); settle() }
    }

    private func recordSize(_ unit: ViewerUnit) {
        guard let video = unit.video, let index = indexes[video.key], unit.presentationSize.width.isFinite, unit.presentationSize.height.isFinite, unit.presentationSize.width >= 32,
              unit.presentationSize.height >= 32, measuredSizes[video.key] != unit.presentationSize else { return }
        measuredSizes[video.key] = unit.presentationSize
        progress.setDisplaySize(video.key, unit.presentationSize)
        videos[index] = videos[index].setting("viewerWidth", Double(unit.presentationSize.width)).setting("viewerHeight", Double(unit.presentationSize.height))
        saveCheckpoint()
    }

    // MARK: zoom

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { scrollView === zoom ? viewport : nil }

    func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
        guard scrollView === zoom, !zoomed else { return }
        zoomed = true
        feed.isScrollEnabled = false
        unsettled = false
        monitor(false)
        overlay.setInteractive(true)
        updateUnitVisibility()
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        guard scrollView === zoom else { return }
        // Keep the whole viewport centred during the spring below minimum scale too.
        viewport.center = CGPoint(x: max(zoom.contentSize.width, zoom.bounds.width) / 2,
                                  y: max(zoom.contentSize.height, zoom.bounds.height) / 2)
    }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        if scrollView === zoom && scale <= 1.01 { exitZoom() }
    }

    private func exitZoom() {
        guard zoomed else { return }
        zoomed = false
        zoom.setZoomScale(1, animated: false)
        feed.isScrollEnabled = true
        settle()
    }

    #if targetEnvironment(simulator)
    // Static geometry checks: no player item, network, audio session or video decoding.
    func configureZoomCheck(size: CGSize, image: UIImage) {
        loadViewIfNeeded()
        let video = ViewerVideo(["filename": "Aspect fit", "provider": "sc", "local": true])!
        videos = [video]
        currentIndex = 0
        active.configureZoomCheck(video: video, size: size, image: image)
        measuredSizes[video.key] = size
        geometryDirty = true
        fixtureImage = image
        revealed = true
        feed.alpha = 1
        view.layoutIfNeeded()
        layoutFeed()
        placeInitialVideo()
        overlay.setVideo(video)
    }

    func configureFeedCheck(image: UIImage, sourceProvider: String = "sc", late: Bool = false) {
        loadViewIfNeeded()
        fixtureImage = image
        fixtureLateMetadata = late
        reservedAspects.removeAll()
        measuredSizes.removeAll()
        videos = (0..<30).map { index in
            let size = sourceProvider == "tango-live" || late ? CGSize(width: 720, height: 1280) : index % 3 == 0 ? CGSize(width: 720, height: 1280) : CGSize(width: 1920, height: 1080)
            var raw: [String: Any] = ["filename": "Fixture \(index)", "provider": sourceProvider, "local": true]
            if !late || ["sc", "fc2", "tango", "bunkr"].contains(sourceProvider) {
                raw["displayWidth"] = Double(size.width); raw["displayHeight"] = Double(size.height)
            }
            let video = ViewerVideo(raw)!
            if !late { measuredSizes[video.key] = size }
            return video
        }
        currentIndex = 3
        if late { active.configurePendingMetadataCheck(video: videos[currentIndex]) }
        else { active.configureZoomCheck(video: videos[currentIndex], size: aspect(of: videos[currentIndex]), image: image) }
        geometryDirty = true
        initialPositionApplied = false
        revealed = true
        feed.alpha = 1
        view.layoutIfNeeded()
        layoutFeed()
        placeInitialVideo()
        loadEdgeUnits()
    }

    func checkMetadataArrival(width: CGFloat, height: CGFloat) -> [String: Any] {
        let before = zoomCheckState
        if let fixtureImage {
            for unit in units {
                guard let video = unit.video else { continue }
                unit.configureZoomCheck(video: video, size: CGSize(width: width, height: height), image: fixtureImage)
                unitGeometryChanged(unit)
            }
        }
        return ["before": before, "after": zoomCheckState]
    }

    func checkDimensionCache() -> [String: Any] {
        progress.flush()
        let reopened = ProgressStore(directory: checkpoint.directory)
        guard let video = currentVideo, let size = reopened.displaySize(video.key) else { return ["cached": false] }
        return ["cached": true, "width": size.width, "height": size.height]
    }

    func checkFeedScroll(delta: CGFloat, end: Bool) -> [String: Any] {
        scrollViewWillBeginDragging(feed)
        feed.contentOffset.y += delta
        scrollViewDidScroll(feed)
        let before = zoomCheckState
        if end { scrollViewDidEndDragging(feed, willDecelerate: false) }
        return ["before": before, "after": zoomCheckState]
    }

    func checkFeedMetadata() -> [String: Any] {
        let before = zoomCheckState
        if let unit = units.first(where: { $0 !== active && $0.video != nil }), let video = unit.video, let fixtureImage {
            unit.configureZoomCheck(video: video, size: CGSize(width: 9, height: 32), image: fixtureImage)
            unitGeometryChanged(unit)
        }
        return ["before": before, "during": zoomCheckState]
    }

    func checkFeedRefresh() -> [String: Any] {
        let before = zoomCheckState
        var fresh = videos.map { video -> ViewerVideo in
            var raw = video.raw
            raw.removeValue(forKey: "viewerWidth")
            raw.removeValue(forKey: "viewerHeight")
            if video.same(currentVideo!) { raw["fileId"] = "fixture-stable-identity" }
            return ViewerVideo(raw)!
        }
        fresh.insert(ViewerVideo(["filename": "Inserted fixture", "provider": "sc", "local": true])!, at: 0)
        updateList(fresh)
        saveCheckpoint()
        savePoster()
        checkpoint.flush()
        let savedSizes = ViewerCheckpoint.load(checkpoint.directory)?.videos.filter { $0.raw["viewerWidth"] != nil }.count ?? 0
        return ["before": before, "after": zoomCheckState, "savedSizes": savedSizes,
                "posterFrame": ViewerPoster.load(checkpoint.directory)?.poster.frame ?? []]
    }

    func configureRestoredFeedCheck(image: UIImage) {
        guard let saved = ViewerCheckpoint.load(checkpoint.directory) else { return }
        fixtureImage = image
        videos = saved.videos
        currentIndex = videos.firstIndex { $0.key == saved.current } ?? 0
        restoredTop = saved.top.map { CGFloat($0) }
        initialPositionApplied = false
        geometryDirty = true
        active.configureZoomCheck(video: videos[currentIndex], size: aspect(of: videos[currentIndex]), image: image)
        revealed = true
        feed.alpha = 1
        view.layoutIfNeeded()
        layoutFeed()
        placeInitialVideo()
        loadEdgeUnits()
        showPoster(for: videos[currentIndex])
    }

    func setZoomCheckScale(_ scale: CGFloat, animated: Bool) { zoom.setZoomScale(scale, animated: animated) }
    func beginZoomCheck() { scrollViewWillBeginZooming(zoom, with: viewForZooming(in: zoom)) }
    func endZoomCheck() { scrollViewDidEndZooming(zoom, with: viewForZooming(in: zoom), atScale: zoom.zoomScale) }

    var zoomCheckState: [String: Any] {
        func rect(_ value: CGRect) -> [CGFloat] { [value.minX, value.minY, value.width, value.height] }
        var surfaces = 0
        func count(_ node: UIView) {
            if let layer = node.layer as? AVPlayerLayer, layer.player === active.player { surfaces += 1 }
            node.subviews.forEach(count)
        }
        count(view)
        return ["viewport": rect(view.bounds), "picture": rect(content.convert(pictureFrame(at: currentIndex) ?? .zero, to: view)),
                "baseSize": [active.view.bounds.width, active.view.bounds.height], "scale": zoom.zoomScale,
                "surface": String(describing: ObjectIdentifier(active.view.playerLayer)), "surfaces": surfaces,
                "carouselEnabled": feed.isScrollEnabled, "index": currentIndex, "zoomed": zoomed,
                "offset": feed.contentOffset.y, "documentHeight": feed.contentSize.height, "poster": poster != nil,
                "key": currentVideo?.key ?? "", "name": currentVideo?.filename ?? "", "visiblePlayers": units.filter { $0.video != nil && !$0.view.isHidden }.count, "players": units.compactMap { unit -> [String: Any]? in
                    guard let video = unit.video else { return nil }
                    return ["key": video.key, "frame": rect(unit.view.convert(unit.view.bounds, to: view)), "visible": !unit.view.isHidden]
                }, "frameKey": geometryKeys.indices.contains(currentIndex) ? geometryKeys[currentIndex] : "",
                "unitKey": active.video?.key ?? ""]
    }
    #endif

    // MARK: gestures

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        // The overlay's controls handle their own touches (the progress bar scrubs).
        !(touch.view?.isDescendant(of: overlay) ?? false)
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === edgePan { return !zoomed }
        guard gestureRecognizer === seekPan else { return true }
        let translation = seekPan.translation(in: view)
        let location = seekPan.location(in: view)
        let start = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
        guard zoomed || start.x > Self.edgeWidth, abs(translation.x) > abs(translation.y) else { return false }
        // Zoomed in, only the seek stays ours; everything else pans the picture.
        return !zoomed || start.y < view.bounds.height / 2
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        gestureRecognizer is ContactRecognizer || other is ContactRecognizer
    }

    @objc private func seekPanned(_ pan: UIPanGestureRecognizer) {
        let translation = pan.translation(in: view)
        switch pan.state {
        case .began:
            let location = pan.location(in: view)
            seeking = location.y - translation.y < view.bounds.height / 2
            seekBase = active.snapshot().currentTime
            fallthrough
        case .changed:
            guard seeking else { return }
            let max = live ? 0 : active.snapshot().seekMax
            guard max > 0 else { return }
            let target = seekBase + Double(translation.x / view.bounds.width * Self.seekSecondsPerWidth)
            active.seek(Swift.max(0, Swift.min(max, target)), resume: false)
        case .ended:
            if seeking { active.play() }
            else if abs(translation.x) > 80 { setControlsVisible(translation.x > 0) }
            seeking = false
        default:
            if seeking { active.play() }
            seeking = false
        }
    }

    private func setControlsVisible(_ visible: Bool) {
        controlsVisible = visible
        overlay.setUiVisible(visible)
    }

    // The left edge slides the viewer away to the list, like Safari's Back.
    @objc private func edgePanned(_ pan: UIScreenEdgePanGestureRecognizer) {
        let x = max(0, pan.translation(in: view.superview).x)
        switch pan.state {
        case .began, .changed:
            view.layer.shadowOpacity = 0.5
            view.transform = CGAffineTransform(translationX: x, y: 0)
        case .ended where x > view.bounds.width / 3 || pan.velocity(in: view.superview).x > 600:
            slideAway()
        default:
            UIView.animate(withDuration: 0.2) { self.view.transform = .identity } completion: { _ in self.view.layer.shadowOpacity = 0 }
        }
    }

    // Off to the right, back to the list.
    func slideAway(reveal: Bool = true) {
        guard !closed else { return }
        view.layer.shadowOpacity = 0.5
        UIView.animate(withDuration: 0.2, delay: 0, options: .curveEaseOut) {
            self.view.transform = CGAffineTransform(translationX: self.view.bounds.width, y: 0)
        } completion: { _ in self.close(reveal: reveal) }
    }

    // MARK: overlay actions

    func overlaySeek(_ time: Double, resume: Bool) { active.seek(time, resume: resume) }

    func overlayToggleMuteOrUndo() {
        if !segments.isEmpty {
            segments.removeLast()
            overlay.setSegments(segments)
            return
        }
        active.muted.toggle()
    }

    func overlayAddMarker() {
        guard let video = currentVideo, video.local, !video.edited else { return }
        let snapshot = active.snapshot()
        guard !snapshot.isLive else { return }
        segments = (segments + [snapshot.currentTime]).sorted()
        overlay.setSegments(segments)
    }

    func overlayRename() {
        guard let video = currentVideo, video.canRename, presentedViewController == nil else { return }
        saveProgress()
        let dialog = UIAlertController(title: "Rename video", message: nil, preferredStyle: .alert)
        dialog.addTextField { field in
            field.text = (video.filename as NSString).deletingPathExtension
            field.placeholder = "New filename"
            field.autocorrectionType = .no
            field.autocapitalizationType = .none
            field.clearButtonMode = .whileEditing
        }
        dialog.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        dialog.addAction(UIAlertAction(title: "Rename", style: .default) { [weak self, weak dialog] _ in
            guard let self, let name = dialog?.textFields?.first?.text else { return }
            self.overlay.setRenaming(true)
            Task { [self] in
                defer { self.overlay.setRenaming(false) }
                do {
                    let renamed = try await self.host.rename(video, to: name)
                    guard !self.closed else { return }
                    self.replace(renamed); self.saveCheckpoint()
                } catch {
                    guard !self.closed else { return }
                    let failed = UIAlertController(title: "Couldn’t rename video", message: error.localizedDescription, preferredStyle: .alert)
                    failed.addAction(UIAlertAction(title: "OK", style: .default))
                    let show = { [weak self] in guard let self, !self.closed, self.viewIfLoaded?.window != nil else { return }; self.present(failed, animated: true) }
                    if let presentedViewController = self.presentedViewController { presentedViewController.dismiss(animated: true, completion: show) }
                    else { show() }
                }
            }
        })
        present(dialog, animated: true)
    }

    func overlaySaveOrCut(_ playbackDuration: Double) {
        guard let video = currentVideo, !video.edited else { return }
        let markers = segments
        guard markers.count % 2 == 0 else { return }
        Task {
            do {
                if markers.isEmpty { try await ViewerPC.save(video) }
                else {
                    guard let url = video.media?.url else { return }
                    let playlist = try await Playlist.fetch(url)
                    try await ViewerPC.cut(video, keep: playlist.keep(markers: markers, playbackDuration: playbackDuration))
                }
                replaceCurrent(video.setting("type", "edited"), replacing: video)
            } catch { mutationFailed(error) }
        }
    }

    func overlayReturnOriginal() {
        guard let video = currentVideo, video.edited else { return }
        Task {
            do {
                try await ViewerPC.returnOriginal(video)
                replaceCurrent(video.setting("type", "original"), replacing: video)
            } catch { mutationFailed(error) }
        }
    }

    private func replaceCurrent(_ video: ViewerVideo, replacing previous: ViewerVideo) {
        guard !closed else { host.changed(video); return }
        guard let index = videos.firstIndex(where: { $0.same(previous) }) ?? videos.firstIndex(where: { $0.same(video) }) else { host.changed(video); return }
        let selected = currentVideo?.sameRecording(previous) == true
        let alreadySelected = selected && active.video?.same(video) == true
        let selectedKey = currentVideo?.key
        var anchor = documentAnchor
        if anchor?.key == previous.key { anchor?.key = video.key }
        carryGeometry(from: previous, to: video)
        for unit in units where (!selected || unit !== active) && unit.video?.sameRecording(previous) == true { unit.clear() }
        if !alreadySelected { progress.set(video.progressKey, 0) }
        // A change feed may already contain the edited row when the action's
        // acknowledgement arrives. Replace once, retaining this document slot.
        let insertion = videos[..<index].filter { !$0.same(previous) && !$0.same(video) }.count
        videos.removeAll { $0.same(previous) || $0.same(video) }
        videos.insert(video, at: insertion)
        if selected { currentIndex = insertion }
        else if let selectedKey, let current = videos.firstIndex(where: { $0.key == selectedKey }) { currentIndex = current }
        geometryDirty = true
        if selected {
            segments = []
            overlay.setSegments(segments)
            if active.video?.same(video) == true { active.update(video) }
            else { loadVariant(video, in: active, play: true) }
        }
        layoutFeed(anchor: anchor)
        loadEdgeUnits()
        if selected { activateCurrent() }
        host.changed(video)
    }

    private func mutationFailed(_ error: Error) {
        print("Video change failed:", error.localizedDescription)
        guard (error as? ViewerPC.Failure)?.status == 404, videos.indices.contains(currentIndex) else { return }
        videos.remove(at: currentIndex)
        if videos.isEmpty { close(); return }
        currentIndex = min(currentIndex, videos.count - 1)
        geometryDirty = true
        loadEdgeUnits()
        activateCurrent()
    }

    func overlayToggleFollow() {
        guard let video = currentVideo, video.liveStream else { return }
        Task {
            do {
                try await host.follow(video, !video.following)
                replace(video.setting("following", !video.following))
            } catch { print("Follow failed:", error.localizedDescription) }
        }
    }

    func overlayBlock() {
        guard let video = currentVideo, video.liveStream else { return }
        Task {
            do {
                try await host.block(video)
                if active.video?.filename == video.filename { removeCurrent() }
            } catch { print("Block failed:", error.localizedDescription) }
        }
    }

    // MARK: units

    func unitTime(_ unit: ViewerUnit, _ snapshot: TimelineSnapshot) {
        guard unit === active else { return }
        if unit.hasPicture { removePoster() }
        FrameMonitor.shared.measure("viewer.time") { showTime(snapshot) }
    }

    private func showTime(_ snapshot: TimelineSnapshot) {
        if provider == "bunkr", !moving, CACurrentMediaTime() - lastPlaybackEvidence >= 2 {
            lastPlaybackEvidence = CACurrentMediaTime()
            BunkrPlaybackDiagnostics.record(units.map(\.playbackEvidence))
        }
        overlay.setTimeline(snapshot)
        let now = CACurrentMediaTime()
        if now - lastProgressSave >= 3 {
            lastProgressSave = now
            saveProgress()
        }
        nowPlaying()
    }

    func unitLiveChanged(_ unit: ViewerUnit, _ isLive: Bool) {
        guard let video = unit.video, video.isLive != isLive else { return }
        let updated = video.setting("isLive", isLive)
        if let index = videos.firstIndex(where: { $0.same(video) }) { videos[index] = updated }
        unit.update(updated)
        if unit === active { overlay.setVideo(updated) }
    }

    func unitMutedChanged(_ unit: ViewerUnit, _ muted: Bool) {
        guard unit === active else { return }
        overlay.setMuted(muted)
        session.setAudible(!muted)
        nowPlaying(force: true)
    }

    func unitUnavailable(_ unit: ViewerUnit) {
        guard unit === active else { return }
        if returnsWhenGone, let video = active.video {
            host.remove(video.filename)
            slideAway()
        } else {
            removeCurrent()
        }
    }

    func unitGeometryChanged(_ unit: ViewerUnit) {
        guard !closed else { return }
        recordSize(unit)
        updateUnitVisibility()
        if unit === active, !revealed, unit.presentationSize != .zero { reveal() }
    }

    func unitNeedsLogin(_ unit: ViewerUnit) {
        close()
        host.login()
    }

    func unitSource(_ video: ViewerVideo) async throws -> MediaSource {
        if let media = video.media { return media }
        let source = try await host.resolve(video)
        if let size = source.displaySize { progress.setDisplaySize(video.key, size) }
        return source
    }

    func unitAsset(_ source: MediaSource, for video: ViewerVideo) async -> AVURLAsset {
        await media.asset(source, for: video)
    }

    private func nowPlaying(force: Bool = false) {
        let now = CACurrentMediaTime()
        guard force || now - lastNowPlaying >= 5 else { return }
        lastNowPlaying = now
        session.nowPlaying(currentVideo, active.snapshot(), playing: active.isPlaying)
    }

    // MARK: the poster

    private func showPoster(for video: ViewerVideo) {
        guard let (saved, image) = ViewerPoster.load(checkpoint.directory), saved.key == video.key else { return }
        // Old regression builds captured neighbouring videos in a full-screen poster.
        // Never revive those neighbours at rest after an update.
        controlsVisible = saved.controls
        guard saved.currentOnly == true else { return }
        let poster = UIImageView(image: image)
        poster.frame = CGRect(x: saved.frame[0], y: saved.frame[1], width: saved.frame[2], height: saved.frame[3])
        poster.contentMode = .scaleToFill
        viewport.addSubview(poster)
        self.poster = poster
        controlsVisible = saved.controls
    }

    private func removePosterWhenPlaying() {
        let layer = active.view.playerLayer
        if active.hasPicture { removePoster(); return }
        posterReady = layer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] layer, _ in
            guard layer.isReadyForDisplay else { return }
            DispatchQueue.main.async { self?.removePoster() }
        }
        // A player that never draws (offline, an ended stream) does not keep a stale picture.
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.removePoster() }
    }

    private func removePoster() {
        posterReady = nil
        poster?.removeFromSuperview()
        poster = nil
    }

    // Leaving the screen: the current picture (the video's part of the unit, as drawn) for a
    // relaunch. Zoomed, or without a picture yet, there is none.
    // The picture is taken here; it is encoded and written in the background (leaving for the
    // background waits for it).
    private func savePoster() {
        FrameMonitor.shared.measure("viewer.poster") { savePosterNow() }
    }

    private func savePosterNow() {
        // Still showing the saved poster: it stays the one to show.
        guard poster == nil else { return }
        guard revealed, !zoomed, let video = currentVideo, active.presentationSize != .zero else { checkpoint.clearPoster(); return }
        // Several partially visible videos can now share the viewport. Preserve that first
        // frame as a whole, rather than restoring only the active video's rectangle.
        let rect = viewport.bounds
        guard rect.width > 1, rect.height > 1 else { checkpoint.clearPoster(); return }
        let visibility = units.map { $0.view.isHidden }
        for unit in units where unit !== active { unit.view.isHidden = true }
        let image = UIGraphicsImageRenderer(bounds: rect).image { _ in viewport.drawHierarchy(in: rect, afterScreenUpdates: false) }
        for (index, unit) in units.enumerated() { unit.view.isHidden = visibility[index] }
        let frame = viewport.convert(rect, to: view)
        checkpoint.savePoster(ViewerPoster(key: video.key, frame: [frame.minX, frame.minY, frame.width, frame.height].map(Double.init), controls: controlsVisible, currentOnly: true),
                              image: image)
    }

    // MARK: lifecycle

    // In the background a player keeps playing only without its picture: the layers let go of
    // their players, and the neighbours wait until the screen is back.
    private func enteredBackground() {
        for unit in units { unit.setVideoEnabled(false) }
        for unit in units where unit !== active { unit.pause() }
        saveProgress()
        progress.flush()
        saveCheckpoint()
        checkpoint.flush()
    }

    private func enteringForeground() {
        #if targetEnvironment(simulator)
        if fixtureImage != nil { return }
        #endif
        for unit in units { unit.setVideoEnabled(true) }
        for unit in units where unit.video != nil {
            if playbackPolicy.shouldPlay(position: unit === active ? 1 : 0, inBackground: false) { unit.resume(liveEdge: unit !== active) }
            else { unit.pause() }
        }
    }

    // A call or Siri paused playback; videos carry on afterwards.
    private func interruptionEnded() {
        #if targetEnvironment(simulator)
        if fixtureImage != nil { return }
        #endif
        active.resume(liveEdge: false)
        if !inBackground && playbackPolicy.playsNeighbors { for unit in units where unit !== active && unit.video != nil { unit.resume(liveEdge: true) } }
    }

    // `reveal`: the list scrolls the last viewed row into view (not for a forward swipe that
    // was let go).
    func close(reveal: Bool = true) {
        guard !closed else { return }
        closed = true
        monitor(false)
        // The list is scrolled right after (measured: the frames of the next second are kept).
        FrameMonitor.shared.scrolling(true)
        FrameMonitor.shared.note("viewer closed")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { FrameMonitor.shared.scrolling(false) }
        FrameMonitor.shared.measure("viewer.close") { closeNow(reveal: reveal) }
    }

    private func closeNow(reveal: Bool) {
        revealTimer?.invalidate()
        // Written in the background (the progress stays in memory; leaving the app waits for it).
        FrameMonitor.shared.measure("close.save") {
            saveProgress()
            checkpoint.clear()
            checkpoint.clearPoster()
        }
        removePoster()
        let filename = currentVideo?.filename
        FrameMonitor.shared.measure("close.units") {
            units.forEach { $0.clear() }
        }
        FrameMonitor.shared.measure("close.session") {
            session.end()
            media.stop()
        }
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        UIApplication.shared.isIdleTimerDisabled = false
        if let filename { FrameMonitor.shared.measure("close.highlight") { host.highlight(filename, reveal: reveal) } }
        FrameMonitor.shared.measure("close.remove") { onClose?() }
    }
}

// The list's scroll view: a horizontal drag is a seek or the controls' swipe, never a scroll.
final class FeedScrollView: UIScrollView {
    var shouldPan: (CGPoint) -> Bool = { _ in true }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer {
            let translation = panGestureRecognizer.translation(in: self)
            let velocity = panGestureRecognizer.velocity(in: self)
            let horizontal = translation == .zero ? abs(velocity.x) > abs(velocity.y) : abs(translation.x) > abs(translation.y)
            if horizontal || !shouldPan(translation) { return false }
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
}

// The permanent viewport. At rest its child scrolls the feed; zoomed its own pan takes over,
// leaving the upper half's horizontal drags to seek.
final class ZoomScrollView: UIScrollView {
    var isActive: () -> Bool = { false }
    var shouldPan: (CGPoint, CGPoint) -> Bool = { _, _ in true }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer, let superview {
            guard isActive() else { return false }
            let translation = panGestureRecognizer.translation(in: superview)
            let location = panGestureRecognizer.location(in: superview)
            let start = CGPoint(x: location.x - translation.x, y: location.y - translation.y)
            if !shouldPan(start, translation) { return false }
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
}

// Whether a finger is down anywhere on the viewer: a swipe settles only once all are up.
final class ContactRecognizer: UIGestureRecognizer {
    private let changed: (Bool) -> Void
    private var count = 0

    init(_ changed: @escaping (Bool) -> Void) {
        self.changed = changed
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        if count == 0 { changed(true) }
        count += touches.count
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) { lift(touches) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { lift(touches) }

    private func lift(_ touches: Set<UITouch>) {
        count = max(0, count - touches.count)
        guard count == 0 else { return }
        changed(false)
        state = .failed
    }

    override func reset() {
        if count > 0 { count = 0; changed(false) }
    }
}
