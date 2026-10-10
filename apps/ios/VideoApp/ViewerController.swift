import AVFoundation
import UIKit
import UIKit.UIGestureRecognizerSubclass

// The native viewer: packages/app src/routes/videoViewer.ts with AVPlayer, over the list page.
// The same intrinsic three-scope feed: a 10,000 pt previous scope, the current video at its
// natural height and a 10,000 pt next scope; at rest the neighbours sit at their scopes' far
// edges, during a vertical swipe they touch the current video, and a neighbour that reaches
// the screen's midpoint becomes current (scope roles rotate, keeping it where it is on screen).
// A landing in the blank runway moves one video in the swipe's direction. All three play muted;
// the mute button unmutes only the current one.
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
    private static let runway: CGFloat = 10_000
    private static let edgeWidth: CGFloat = 28
    private static let seekSecondsPerWidth: CGFloat = 60

    let provider: String
    var onClose: (() -> Void)?
    private let bridge: ViewerBridge
    private let media: ViewerMedia
    private let progress: ProgressStore
    private let directory: URL

    private let feed = FeedScrollView()
    private let content = UIView()
    private let overlay = ViewerOverlay()
    private let message = UILabel()
    private let zoom = ZoomScrollView()
    private let zoomContent = PlayerView()
    private let session = ViewerSession()
    private var units: [ViewerUnit] = []
    private var videos: [ViewerVideo]
    private var currentIndex: Int
    private var segments: [Double] = []
    private var controlsVisible = true
    private var unsettled = false
    private var programmatic = false
    private var touching = false
    private var lastOffset: CGFloat = 0
    private var scrollDirection = 0
    private var lastProgressSave: CFTimeInterval = 0
    private var lastNowPlaying: CFTimeInterval = 0
    private var discovered = Set<String>()
    private var removed = Set<String>()
    private var revealed = false
    private var revealTimer: Timer?
    private var zoomed = false
    private var preparingZoom = false
    private var zoomAnchor: CGFloat = 0.5
    private var seekPan: UIPanGestureRecognizer!
    private var edgePan: UIScreenEdgePanGestureRecognizer!
    private var seekBase: Double = 0
    private var seeking = false
    private var observers: [NSObjectProtocol] = []
    private var lastBounds: CGSize = .zero
    private var closed = false

    init(provider: String, videos: [ViewerVideo], index: Int, bridge: ViewerBridge, media: ViewerMedia,
         progress: ProgressStore, directory: URL) {
        self.provider = provider
        self.videos = videos
        currentIndex = index
        self.bridge = bridge
        self.media = media
        self.progress = progress
        self.directory = directory
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    var currentVideo: ViewerVideo? { videos.indices.contains(currentIndex) ? videos[currentIndex] : active.video }
    private var active: ViewerUnit { units[1] }
    private var live: Bool { currentVideo?.liveStream ?? false }
    private var inBackground: Bool { UIApplication.shared.applicationState == .background }

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
        view.addSubview(feed)
        units = (0..<3).map { _ in
            let unit = ViewerUnit()
            unit.delegate = self
            content.addSubview(unit.view)
            return unit
        }

        zoom.delegate = self
        zoom.backgroundColor = .black
        zoom.alpha = 0
        zoom.minimumZoomScale = 1
        zoom.maximumZoomScale = 5
        zoom.showsVerticalScrollIndicator = false
        zoom.showsHorizontalScrollIndicator = false
        zoom.contentInsetAdjustmentBehavior = .never
        zoom.addSubview(zoomContent)
        zoom.isActive = { [weak self] in self?.zoomed ?? false }
        view.addSubview(zoom)
        // A pinch anywhere zooms the current video, as Safari zooms its page.
        if let pinch = zoom.pinchGestureRecognizer { view.addGestureRecognizer(pinch) }

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
            if !down { settle() }
        }
        contact.delegate = self
        view.addGestureRecognizer(contact)
        for pan in [feed.panGestureRecognizer, zoom.panGestureRecognizer, seekPan!] { pan.require(toFail: edgePan) }
        feed.shouldPan = { [weak self] _ in self?.zoomed == false }
        zoom.shouldPan = { [weak self] start, translation in
            guard let self else { return true }
            return !(abs(translation.x) > abs(translation.y) && start.y < self.view.bounds.height / 2)
        }

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

        // The selected video gets the network first; its neighbours load once it has a picture.
        guard let video = currentVideo else { return }
        overlay.setVideo(video)
        overlay.setUiVisible(controlsVisible)
        overlay.setMuted(true)
        active.load(video, start: savedTime(video), play: true)
        revealTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.reveal() }
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        feed.frame = view.bounds
        zoom.frame = view.bounds
        overlay.frame = view.bounds
        message.frame = view.bounds.insetBy(dx: 20, dy: 0)
        view.layer.shadowPath = UIBezierPath(rect: view.bounds).cgPath
        guard view.bounds.size != lastBounds else { return }
        lastBounds = view.bounds.size
        if zoomed { exitZoom() }
        layoutFeed()
        if revealed && !unsettled { centerActive() }
        prepareZoom()
    }

    // MARK: the list

    // The page's list changed (packages/app routes/nativeViewer.ts list): videoViewer.ts updateCanonicalList.
    func updateList(_ list: [ViewerVideo]) {
        guard !closed, !list.isEmpty || live else { return }
        let current = active.video
        let filtered = live ? list.filter { !removed.contains($0.filename) } : list
        // A live stream that ended before this list arrived: the next one takes its place.
        if let current, live, removed.contains(current.filename) {
            let position = list.firstIndex { $0.filename == current.filename }
            videos = filtered
            showAt(position.map { list[..<$0].filter { !removed.contains($0.filename) }.count } ?? 0)
            bridge.send("remove", [current.filename])
            return
        }
        guard let current, let index = filtered.firstIndex(where: {
            $0.same(current) || ($0.pageUrl != nil && $0.pageUrl == current.pageUrl)
        }) else { return }
        videos = filtered
        currentIndex = index
        active.update(filtered[index])
        overlay.setVideo(filtered[index])
        if revealed { loadEdgeUnits() }
    }

    // Opening the video that is already showing (the page restoring its viewer address) changes nothing.
    func shows(_ video: ViewerVideo) -> Bool { currentVideo.map { $0.same(video) } ?? false }

    private func video(at index: Int) -> ViewerVideo? { videos.indices.contains(index) ? videos[index] : nil }

    private func savedTime(_ video: ViewerVideo) -> Double { video.liveStream ? 0 : progress.time(video.filename) }

    private func saveProgress() {
        guard let video = currentVideo, !video.liveStream else { return }
        progress.set(video.filename, active.snapshot().currentTime)
    }

    private func saveCheckpoint() {
        guard let video = currentVideo else { return }
        ViewerCheckpoint(provider: provider, videos: videos, current: video.key).save(directory)
    }

    private func reveal() {
        guard !revealed, !closed else { return }
        revealed = true
        revealTimer?.invalidate()
        layoutFeed()
        centerActive()
        UIView.animate(withDuration: 0.12) { self.feed.alpha = 1 }
        loadEdgeUnits()
        activateCurrent()
        prepareZoom()
    }

    private func loadEdgeUnits() {
        let targets = [video(at: currentIndex - 1), video(at: currentIndex), video(at: currentIndex + 1)]
        for (position, unit) in units.enumerated() {
            guard let video = targets[position] else { unit.clear(); continue }
            if let current = unit.video, current.same(video) { unit.update(video); continue }
            // In the background only the current video plays; its neighbours wait for the screen.
            unit.load(video, start: savedTime(video), play: position == 1 || !inBackground)
        }
        layoutFeed()
    }

    private func activateCurrent() {
        for (position, unit) in units.enumerated() {
            if position != 1 { unit.muted = true }
            if position == 1 || !inBackground { unit.play() }
        }
        guard let video = currentVideo else { return }
        overlay.setVideo(video)
        overlay.setTimeline(active.snapshot())
        overlay.setMuted(active.muted)
        overlay.setSegments(segments)
        overlay.showMembership(video.membership)
        overlay.setUiVisible(controlsVisible)
        overlay.setInteractive(!unsettled)
        session.setAudible(!active.muted)
        nowPlaying(force: true)
        bridge.send("highlight", [video.filename, false])
        saveCheckpoint()
        discover(video)
    }

    // As in Stream Viewer: once per streamer (not for co-streamers), co-streamers new to the list
    // join at the bottom; existing entries keep their place.
    private func discover(_ video: ViewerVideo) {
        guard video.liveStream, video.parent == nil, !discovered.contains(video.filename) else { return }
        discovered.insert(video.filename)
        Task {
            do {
                let fresh = (try await bridge.call("related", [video.raw]) as? [Any] ?? []).compactMap(ViewerVideo.init)
                    .filter { !removed.contains($0.filename) }
                if !fresh.isEmpty && videos.contains(where: { $0.filename == video.filename }) {
                    bridge.send("append", [fresh.map(\.raw)])
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
        bridge.send("remove", [video.filename])
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
        loadEdgeUnits()
        activateCurrent()
    }

    private func replace(_ video: ViewerVideo) {
        if let index = videos.firstIndex(where: { $0.filename == video.filename }) { videos[index] = video }
        if active.video?.filename == video.filename { active.update(video) }
        if currentVideo?.filename == video.filename { overlay.setVideo(video) }
    }

    // MARK: the feed

    private func height(_ unit: ViewerUnit) -> CGFloat {
        guard unit.hasMedia else { return 0 }
        let size = unit.presentationSize
        let width = feed.bounds.width
        return size.width > 0 && size.height > 0 ? width * size.height / size.width : width * 9 / 16
    }

    private func layoutFeed() {
        guard units.count == 3 else { return }
        let width = feed.bounds.width, runway = Self.runway
        let heights = units.map(height)
        units[0].view.frame = CGRect(x: 0, y: unsettled ? runway - heights[0] : 0, width: width, height: heights[0])
        units[1].view.frame = CGRect(x: 0, y: runway, width: width, height: heights[1])
        units[2].view.frame = CGRect(x: 0, y: unsettled ? runway + heights[1] : 2 * runway + heights[1] - heights[2],
                                     width: width, height: heights[2])
        content.frame = CGRect(x: 0, y: 0, width: width, height: 2 * runway + heights[1])
        feed.contentSize = content.frame.size
    }

    private var midpoint: CGFloat { feed.contentOffset.y + feed.bounds.height / 2 }

    private func unitAtMidpoint(_ midpoint: CGFloat) -> Int {
        units.firstIndex { $0.hasMedia && $0.view.frame.minY <= midpoint && midpoint < $0.view.frame.maxY } ?? -1
    }

    private func setOffset(_ y: CGFloat) {
        programmatic = true
        feed.contentOffset = CGPoint(x: 0, y: y)
        lastOffset = y
        programmatic = false
    }

    private func centerActive() {
        setOffset(active.view.frame.midY - feed.bounds.height / 2)
    }

    private func beginUnsettled() {
        guard !unsettled else { return }
        unsettled = true
        lastOffset = feed.contentOffset.y
        scrollDirection = 0
        layoutFeed()
        overlay.setInteractive(false)
    }

    private func commitMidpointVideo() {
        guard unsettled else { return }
        let winner = unitAtMidpoint(midpoint)
        if winner == 0 || winner == 2 { commitScope(winner == 0 ? -1 : 1) }
    }

    // Rotate the scope roles; the selected video stays where it is on screen, even during momentum.
    private func commitScope(_ direction: Int) {
        guard video(at: currentIndex + direction) != nil else { return }
        saveProgress()
        let selected = direction == 1 ? units[2] : units[0]
        let screenTop = selected.view.frame.minY - feed.contentOffset.y
        units = direction == 1 ? [units[1], units[2], units[0]] : [units[2], units[0], units[1]]
        currentIndex += direction
        segments = []
        layoutFeed()
        setOffset(active.view.frame.minY - screenTop)
        loadEdgeUnits()
        activateCurrent()
    }

    // After the finger is up and momentum is over: a runway landing selects one neighbour in the
    // swipe's direction and centres it; otherwise the current video keeps its place on screen.
    private func settle() {
        guard unsettled, !touching, !feed.isDragging, !feed.isDecelerating, !closed else { return }
        let winner = unitAtMidpoint(midpoint)
        if winner == 0 || winner == 2 { commitScope(winner == 0 ? -1 : 1) }
        else if winner == -1 && scrollDirection != 0 { commitScope(scrollDirection) }
        let frame = active.view.frame
        let height = feed.bounds.height
        let top = frame.minY - feed.contentOffset.y
        let outside = height / 2 < top || height / 2 >= top + frame.height
        let desiredTop = outside ? height / 2 - frame.height / 2 : top
        unsettled = false
        layoutFeed()
        overlay.setInteractive(true)
        setOffset(active.view.frame.minY - desiredTop)
        prepareZoom()
    }

    // The lock screen's next/previous: the neighbour, centred.
    private func step(_ direction: Int) {
        guard !unsettled, video(at: currentIndex + direction) != nil else { return }
        if zoomed { exitZoom() }
        unsettled = true
        layoutFeed()
        commitScope(direction)
        unsettled = false
        layoutFeed()
        centerActive()
        overlay.setInteractive(true)
        prepareZoom()
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        if scrollView === feed { beginUnsettled() }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === feed, !programmatic else { return }
        let delta = feed.contentOffset.y - lastOffset
        if abs(delta) >= 0.5 { scrollDirection = delta > 0 ? 1 : -1 }
        lastOffset = feed.contentOffset.y
        commitMidpointVideo()
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if scrollView === feed && !decelerate { settle() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        if scrollView === feed { settle() }
    }

    // MARK: zoom

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { scrollView === zoom ? zoomContent : nil }

    // The zoom view waits, invisible, with the current video where it is on screen.
    private func prepareZoom() {
        guard !zoomed, revealed, active.hasMedia else { return }
        let frame = active.view.frame
        let height = view.bounds.height
        let top = frame.minY - feed.contentOffset.y
        preparingZoom = true
        zoom.zoomScale = 1
        preparingZoom = false
        zoomContent.frame = CGRect(origin: .zero, size: frame.size)
        zoom.contentSize = frame.size
        zoomAnchor = height - frame.height > 1 ? max(0, min(1, top / (height - frame.height))) : 0.5
        applyZoomInsets()
        let maxOffset = max(0, frame.height - height)
        zoom.contentOffset = CGPoint(x: 0, y: frame.height <= height ? -zoom.contentInset.top : max(0, min(maxOffset, -top)))
    }

    private func applyZoomInsets() {
        let height = view.bounds.height, content = zoomContent.frame.height
        let top = content < height ? (height - content) * zoomAnchor : 0
        zoom.contentInset = UIEdgeInsets(top: top, left: 0, bottom: content < height ? height - content - top : 0, right: 0)
    }

    func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
        guard scrollView === zoom, !zoomed, !preparingZoom else { return }
        zoomed = true
        zoomContent.playerLayer.player = inBackground ? nil : active.player
        zoom.alpha = 1
        feed.isScrollEnabled = false
    }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        if scrollView === zoom { applyZoomInsets() }
    }

    func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        if scrollView === zoom && scale <= 1.01 { exitZoom() }
    }

    private func exitZoom() {
        guard zoomed else { return }
        zoomed = false
        zoom.alpha = 0
        zoomContent.playerLayer.player = nil
        feed.isScrollEnabled = true
        prepareZoom()
    }

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
            UIView.animate(withDuration: 0.2, delay: 0, options: .curveEaseOut) {
                self.view.transform = CGAffineTransform(translationX: self.view.bounds.width, y: 0)
            } completion: { _ in self.close() }
        default:
            UIView.animate(withDuration: 0.2) { self.view.transform = .identity } completion: { _ in self.view.layer.shadowOpacity = 0 }
        }
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
                segments = []
                replaceCurrent(video.setting("type", "edited"))
            } catch { mutationFailed(error) }
        }
    }

    func overlayReturnOriginal() {
        guard let video = currentVideo, video.edited else { return }
        Task {
            do {
                try await ViewerPC.returnOriginal(video)
                replaceCurrent(video.setting("type", "original"))
            } catch { mutationFailed(error) }
        }
    }

    private func replaceCurrent(_ video: ViewerVideo) {
        guard videos.indices.contains(currentIndex) else { return }
        videos[currentIndex] = video
        overlay.setSegments(segments)
        active.load(video, start: 0, play: true)
        activateCurrent()
    }

    private func mutationFailed(_ error: Error) {
        print("Video change failed:", error.localizedDescription)
        guard (error as? ViewerPC.Failure)?.status == 404, videos.indices.contains(currentIndex) else { return }
        videos.remove(at: currentIndex)
        if videos.isEmpty { close(); return }
        currentIndex = min(currentIndex, videos.count - 1)
        loadEdgeUnits()
        activateCurrent()
    }

    func overlayToggleFollow() {
        guard let video = currentVideo, video.liveStream else { return }
        Task {
            do {
                _ = try await bridge.call("follow", [video.raw, !video.following])
                replace(video.setting("following", !video.following))
            } catch { print("Follow failed:", error.localizedDescription) }
        }
    }

    func overlayBlock() {
        guard let video = currentVideo, video.liveStream else { return }
        Task {
            do {
                _ = try await bridge.call("block", [video.raw])
                if active.video?.filename == video.filename { removeCurrent() }
            } catch { print("Block failed:", error.localizedDescription) }
        }
    }

    // MARK: units

    func unitTime(_ unit: ViewerUnit, _ snapshot: TimelineSnapshot) {
        guard unit === active else { return }
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
        if unit === active { removeCurrent() }
    }

    func unitGeometryChanged(_ unit: ViewerUnit) {
        layoutFeed()
        guard unit === active else { return }
        if !revealed, unit.presentationSize != .zero { reveal() }
        else if !unsettled { prepareZoom() }
    }

    func unitNeedsLogin(_ unit: ViewerUnit) {
        close()
        bridge.send("login")
    }

    func unitSource(_ video: ViewerVideo) async throws -> MediaSource {
        if let media = video.media { return media }
        return try await bridge.resolve(video)
    }

    func unitAsset(_ source: MediaSource, for video: ViewerVideo) async -> AVURLAsset {
        await media.asset(source, for: video)
    }

    private func nowPlaying(force: Bool = false) {
        let now = CACurrentMediaTime()
        guard force || now - lastNowPlaying >= 5 else { return }
        lastNowPlaying = now
        session.nowPlaying(currentVideo, active.snapshot(), playing: active.player.rate > 0)
    }

    // MARK: lifecycle

    // In the background a player keeps playing only without its picture: the layers let go of
    // their players, and the neighbours wait until the screen is back.
    private func enteredBackground() {
        for unit in units { unit.view.playerLayer.player = nil }
        zoomContent.playerLayer.player = nil
        for (position, unit) in units.enumerated() where position != 1 { unit.pause() }
        saveProgress()
        progress.flush()
        saveCheckpoint()
    }

    private func enteringForeground() {
        for unit in units { unit.view.playerLayer.player = unit.player }
        if zoomed { zoomContent.playerLayer.player = active.player }
        for (position, unit) in units.enumerated() where unit.video != nil {
            unit.resume(liveEdge: position != 1)
        }
    }

    // A call or Siri paused playback; videos carry on afterwards.
    private func interruptionEnded() {
        active.resume(liveEdge: false)
        if !inBackground { for (position, unit) in units.enumerated() where position != 1 && unit.video != nil { unit.resume(liveEdge: true) } }
    }

    func close() {
        guard !closed else { return }
        closed = true
        revealTimer?.invalidate()
        saveProgress()
        progress.flush()
        ViewerCheckpoint.clear(directory)
        let filename = currentVideo?.filename
        units.forEach { $0.clear() }
        zoomContent.playerLayer.player = nil
        session.end()
        media.stop()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        UIApplication.shared.isIdleTimerDisabled = false
        if let filename { bridge.send("highlight", [filename, true]) }
        onClose?()
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

// The zoomed picture. It takes touches only while zoomed; its pan leaves the upper half's
// horizontal drags to the seek.
final class ZoomScrollView: UIScrollView {
    var isActive: () -> Bool = { false }
    var shouldPan: (CGPoint, CGPoint) -> Bool = { _, _ in true }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        isActive() ? super.hitTest(point, with: event) : nil
    }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer, let superview {
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
