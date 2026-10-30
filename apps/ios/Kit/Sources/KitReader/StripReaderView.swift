#if canImport(UIKit)
import UIKit
import UIKit.UIGestureRecognizerSubclass
import KitCore
import KitImages

// A reader position: the image at the screen's vertical centre and how far down that image
// the centre is (the manga and gallery readers' `page` and `f`).
public struct StripPosition: Codable, Sendable, Equatable {
    public var index: Int
    public var fraction: Double
    public init(index: Int, fraction: Double) {
        self.index = index
        self.fraction = min(max(fraction.isFinite ? fraction : 0, 0), 1)
    }
}

public struct StripPage: Sendable, Equatable {
    public var key: String
    // width / height, when known before loading (from a manifest or the provider).
    public var aspect: CGFloat?
    public init(key: String, aspect: CGFloat?) {
        self.key = key
        self.aspect = aspect.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
    }
}

@MainActor
public protocol StripReaderDelegate: AnyObject {
    func strip(_ strip: StripReaderView, sourceFor index: Int) -> ImageSource
    // Finger up and momentum (or a zoom) over: save the position.
    func strip(_ strip: StripReaderView, settledAt position: StripPosition)
    // The visible range reached the last pages (time to append the next chapter).
    func stripNearEnd(_ strip: StripReaderView)
    // Text drawn over a page that failed to load, nil for none.
    func strip(_ strip: StripReaderView, failureTextFor index: Int, error: Error) -> String?
    // The page's file when it is already on the phone (a relaunch shows it in its first frame:
    // ImagePipeline.beginRestore).
    func strip(_ strip: StripReaderView, localFileFor index: Int) -> URL?
}

public extension StripReaderDelegate {
    func strip(_ strip: StripReaderView, localFileFor index: Int) -> URL? { nil }
    func stripNearEnd(_ strip: StripReaderView) {}
    func strip(_ strip: StripReaderView, failureTextFor index: Int, error: Error) -> String? { nil }
}

// The vertical image strip WebKit drew for the readers, owned natively: full-width pages with
// no gaps on black, half a screen of space above the first and below the last, the whole
// strip pinch-zoomed and panned as Safari zooms a page (double tap zooms in or back out).
// Pages are laid out from known sizes (a placeholder until the image says otherwise) and the
// page at the screen's centre stays where it is when pages above it change size. Only pages
// near the screen hold decoded images; every page loads when it comes near.
@MainActor
public final class StripReaderView: UIView, UIScrollViewDelegate {
    public weak var delegate: StripReaderDelegate?
    public let pipeline: ImagePipeline
    // Height of a page whose size is unknown, for a given page width.
    public var placeholderHeight: (CGFloat) -> CGFloat = { $0 * 1.5 }
    // How many screens beyond the visible one hold decoded pages.
    public var preloadScreens: CGFloat = 1.5
    public let scrollView = UIScrollView()

    public private(set) var pages: [StripPage] = []
    private let content = UIView()
    private var tops: [CGFloat] = []
    private var heights: [CGFloat] = []
    private var cells: [Int: PageCell] = [:]
    private var reuse: [PageCell] = []
    private var failures: [Int: (attempts: Int, retryAt: CFTimeInterval)] = [:]
    private var laidOutWidth: CGFloat = 0
    private var pendingPosition: StripPosition?
    private var pendingTop: Int?
    // A page opened at its top keeps its top at the screen's top while sizes settle (until a
    // finger touches), instead of the centre: a resumed page never slides away.
    private var pinnedTop: Int?
    private var touching = false
    private var lastNearEnd = -1
    private let footer = UILabel()
    // Keep the rendered pages and their base geometry stable for the whole pinch. Sharper
    // decodes, newly learned sizes and appended chapters commit after UIKit finishes zooming.
    private var zoomInProgress = false
    private var pinchQuality: CGFloat = 1
    private var pendingAspects: [Int: CGFloat] = [:]
    private var pendingAppend = false
    private var pendingImages: [Int: UIImage] = [:]
    private var measuredImages = Set<String>()

    public init(pipeline: ImagePipeline) {
        self.pipeline = pipeline
        super.init(frame: .zero)
        backgroundColor = .black
        scrollView.delegate = self
        scrollView.backgroundColor = .black
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 5
        scrollView.bouncesZoom = true
        scrollView.scrollsToTop = false
        content.backgroundColor = .black
        footer.font = .systemFont(ofSize: 14)
        footer.textAlignment = .center
        footer.numberOfLines = 0
        footer.isHidden = true
        content.addSubview(footer)
        scrollView.addSubview(content)
        addSubview(scrollView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
        let touch = TouchTracker { [weak self] down in
            self?.touching = down
            if down { self?.pinnedTop = nil }
            if !down { self?.settleIfIdle() }
        }
        scrollView.addGestureRecognizer(touch)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    // MARK: pages

    public func setPages(_ pages: [StripPage], position: StripPosition? = nil) {
        pendingAspects = [:]
        pendingAppend = false
        pendingImages = [:]
        measuredImages = []
        pinnedTop = nil
        cells.values.forEach(recycle)
        cells.removeAll()
        failures.removeAll()
        lastNearEnd = -1
        self.pages = pages
        relayout(keeping: nil)
        if let position { scroll(to: position) }
    }

    // New pages after the last (the next chapter); nothing on screen moves.
    public func append(_ more: [StripPage]) {
        guard !more.isEmpty else { return }
        let screen = screenAnchor
        pages += more
        // Callers index chapters from pages.count immediately, even while a pinch holds
        // the old geometry. The model advances now; only its frames wait.
        if zoomInProgress { pendingAppend = true; return }
        relayout(keeping: nil, screen: screen)
    }

    // A line under the last page (the next part loading, or why it cannot); nil hides it.
    public func setFooter(_ text: String?, color: UIColor = UIColor(white: 0.53, alpha: 1)) {
        footer.text = text
        footer.textColor = color
        footer.isHidden = text == nil
        layoutFooter()
    }

    private func layoutFooter() {
        guard laidOutWidth > 0, !footer.isHidden else { return }
        let width = laidOutWidth - 40
        let bottom = tops.last.map { $0 + (heights.last ?? 0) } ?? padding
        footer.frame = CGRect(x: 20, y: bottom + 20, width: width, height: footer.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height)
    }

    // A page's real size became known; the page at the centre keeps its place on screen to the
    // point (its top stays exactly where it is, not re-derived from a fraction, which would
    // drift by part of a pixel every time a page elsewhere loads).
    public func setAspect(_ aspect: CGFloat, at index: Int) {
        guard pages.indices.contains(index), aspect.isFinite, aspect > 0 else { return }
        // A size within a pixel or two of the known one (a site's metadata against the file it
        // serves) is the same page: kept, the layout stays what it was in every session.
        if let known = pages[index].aspect, abs(known - aspect) / known < 0.003 { pendingAspects[index] = nil; return }
        if zoomInProgress { pendingAspects[index] = aspect; return }
        let screen = screenAnchor
        pages[index].aspect = aspect
        relayout(keeping: nil, screen: screen)
    }

    // The page at the screen's centre and where its top is on screen.
    private var screenAnchor: (index: Int, top: CGFloat)? {
        guard laidOutWidth > 0, !tops.isEmpty else { return nil }
        let index = pageIndex(atContentY: centreContentY)
        return (index, tops[index] * scrollView.zoomScale - scrollView.contentOffset.y)
    }

    // MARK: position

    public var currentPosition: StripPosition? { laidOutWidth > 0 ? position(atContentY: centreContentY) : nil }

    // Puts `position` at the screen's centre (applied after the first layout if needed).
    public func scroll(to position: StripPosition) {
        guard laidOutWidth > 0, heights.indices.contains(position.index) else { pendingPosition = position; pendingTop = nil; pinnedTop = nil; return }
        pendingPosition = nil
        pendingTop = nil
        pinnedTop = nil
        let y = tops[position.index] + heights[position.index] * position.fraction
        setCentre(contentY: y)
    }

    // Puts a page's top at the top of the screen (a resumed page, read from its start).
    public func scroll(toTopOf index: Int) {
        guard laidOutWidth > 0, heights.indices.contains(index) else {
            if pages.indices.contains(index) { pendingTop = index }
            return
        }
        pendingTop = nil
        pendingPosition = nil
        pinnedTop = index
        setCentre(contentY: tops[index] + bounds.height / 2 / scrollView.zoomScale)
    }

    private var visibleContent: CGRect { content.convert(scrollView.bounds, from: scrollView) }
    private var centreContentY: CGFloat { visibleContent.midY }

    private func position(atContentY y: CGFloat) -> StripPosition? {
        guard !tops.isEmpty else { return nil }
        let index = pageIndex(atContentY: y)
        return StripPosition(index: index, fraction: Double((y - tops[index]) / max(heights[index], 1)))
    }

    private func setCentre(contentY y: CGFloat) {
        setOffset(y * scrollView.zoomScale - scrollView.bounds.height / 2)
    }

    private func setOffset(_ y: CGFloat) {
        let maxOffset = max(0, scrollView.contentSize.height - scrollView.bounds.height)
        scrollView.contentOffset = CGPoint(x: scrollView.contentOffset.x, y: min(max(0, y), maxOffset))
    }

    // The page containing content y (clamped to the first and last page).
    private func pageIndex(atContentY y: CGFloat) -> Int {
        var low = 0, high = tops.count - 1
        while low < high {
            let middle = (low + high + 1) / 2
            if tops[middle] <= y { low = middle } else { high = middle - 1 }
        }
        return low
    }

    // MARK: layout

    override public func layoutSubviews() {
        super.layoutSubviews()
        let anchor = laidOutWidth > 0 ? currentPosition : nil
        if scrollView.frame != bounds { scrollView.frame = bounds }
        if bounds.width != laidOutWidth { relayout(keeping: anchor) }
        if let pendingPosition { scroll(to: pendingPosition) }
        if let pendingTop { scroll(toTopOf: pendingTop) }
        updateVisible()
    }

    private var padding: CGFloat { bounds.height / 2 }

    private func relayout(keeping anchor: StripPosition?, screen: (index: Int, top: CGFloat)? = nil) {
        FrameMonitor.shared.measure("strip.relayout") { relayoutNow(keeping: anchor, screen: screen) }
    }

    private func relayoutNow(keeping anchor: StripPosition?, screen: (index: Int, top: CGFloat)?) {
        let width = bounds.width
        guard width > 0 else { return }
        laidOutWidth = width
        tops = []
        heights = []
        var y = padding
        for page in pages {
            let height = page.aspect.map { width / $0 } ?? placeholderHeight(width)
            tops.append(y)
            heights.append(height)
            y += height
        }
        let total = y + padding
        let zoom = scrollView.zoomScale
        content.bounds = CGRect(x: 0, y: 0, width: width, height: total)
        content.center = CGPoint(x: width * zoom / 2, y: total * zoom / 2)
        scrollView.contentSize = CGSize(width: width * zoom, height: total * zoom)
        for (index, cell) in cells { cell.frame = frame(of: index) }
        layoutFooter()
        // A place asked for before the first layout (a restored reader) comes first: a page that
        // reports its size during that layout (an image decoded at once) must not anchor to the
        // unrestored top and drop it.
        if let pinnedTop, pages.indices.contains(pinnedTop) { setCentre(contentY: tops[pinnedTop] + bounds.height / 2 / scrollView.zoomScale) }
        else if let pendingTop, pages.indices.contains(pendingTop) { scroll(toTopOf: pendingTop) }
        else if let pendingPosition, pages.indices.contains(pendingPosition.index) { scroll(to: pendingPosition) }
        else if let screen, pages.indices.contains(screen.index) { setOffset(tops[screen.index] * zoom - screen.top) }
        else if let anchor, pages.indices.contains(anchor.index) { scroll(to: anchor) }
        updateVisible()
    }

    private func frame(of index: Int) -> CGRect { CGRect(x: 0, y: tops[index], width: laidOutWidth, height: heights[index]) }

    // MARK: visible pages

    private func updateVisible() {
        guard !tops.isEmpty, laidOutWidth > 0 else { return }
        let visible = visibleContent
        let visibleTop = visible.minY, visibleHeight = visible.height
        let margin = visibleHeight * preloadScreens
        let first = pageIndex(atContentY: visibleTop - margin), last = pageIndex(atContentY: visibleTop + visibleHeight + margin)
        let wanted = Set(first...last)
        // UIKit reports intermediate offsets and scales in separate callbacks. Recycling on
        // one of those transient ranges can discard the picture under the fingers.
        for (index, cell) in cells where !zoomInProgress && !wanted.contains(index) {
            recycle(cell)
            cells[index] = nil
        }
        let widthPixels = Int((laidOutWidth * (zoomInProgress ? pinchQuality : zoomBucket) * (window?.screen.scale ?? 3)).rounded(.up))
        // The pages on screen first, then outwards.
        // Slices of tall pages within a screen of the visible part are attached; the rest let go.
        let shown = CGRect(x: 0, y: visibleTop - visibleHeight, width: laidOutWidth, height: visibleHeight * 3)
        for index in (first...last).sorted(by: { distanceFromScreen($0) < distanceFromScreen($1) }) {
            let cell = cells[index] ?? dequeue(index)
            if cell.fit != .width(widthPixels) || (!cell.hasImage && cell.ticket == nil && retryDue(index)) { request(index, cell: cell, width: widthPixels) }
            cell.reveal(shown.offsetBy(dx: 0, dy: -tops[index]), retaining: zoomInProgress)
        }
        pipeline.prioritiesChanged()
        if last >= pages.count - 3, lastNearEnd != pages.count {
            lastNearEnd = pages.count
            delegate?.stripNearEnd(self)
        }
    }

    // Zoomed in, pages decode sharper (in steps, so a pinch does not decode every frame).
    private var zoomBucket: CGFloat {
        let zoom = scrollView.zoomScale
        return zoom <= 1.3 ? 1 : zoom <= 2.6 ? 2.5 : 5
    }

    private func dequeue(_ index: Int) -> PageCell {
        let cell = reuse.popLast() ?? PageCell()
        cell.index = index
        cell.frame = frame(of: index)
        content.addSubview(cell)
        cells[index] = cell
        return cell
    }

    private func recycle(_ cell: PageCell) {
        pendingImages[cell.index] = nil
        cell.ticket?.cancel()
        cell.reset()
        cell.removeFromSuperview()
        if reuse.count < 12 { reuse.append(cell) }
    }

    private func retryDue(_ index: Int) -> Bool { failures[index].map { CACurrentMediaTime() >= $0.retryAt } ?? true }

    private func request(_ index: Int, cell: PageCell, width: Int) {
        guard let delegate else { return }
        cell.ticket?.cancel()
        cell.fit = .width(width)
        let key = pages[index].key
        let request = ImagePipeline.Request(key: key, source: delegate.strip(self, sourceFor: index), fit: .width(width),
                                            localFile: delegate.strip(self, localFileFor: index)) { [weak self] in
            guard let self, self.pages.indices.contains(index) else { return .infinity }
            return self.distanceFromScreen(index)
        }
        cell.ticket = pipeline.load(request) { [weak self, weak cell] result in
            guard let self, let cell, cell.index == index else { return }
            cell.ticket = nil
            switch result {
            case .success(let image):
                failures[index] = nil
                if zoomInProgress && cell.hasImage { pendingImages[index] = image }
                else { show(image, at: index, cell: cell) }
            case .failure(let error):
                if error is CancellationError { return }
                let attempts = (failures[index]?.attempts ?? 0) + 1
                failures[index] = (attempts, CACurrentMediaTime() + min(30, pow(2, Double(attempts - 1))))
                cell.showFailure(self.delegate?.strip(self, failureTextFor: index, error: error))
                DispatchQueue.main.asyncAfter(deadline: .now() + min(30, pow(2, Double(attempts - 1)))) { [weak self] in self?.updateVisible() }
            }
        }
    }

    private func show(_ image: UIImage, at index: Int, cell: PageCell) {
        FrameMonitor.shared.note("page \(Int(image.size.width * image.scale))x\(Int(image.size.height * image.scale))")
        FrameMonitor.shared.measure("strip.show") {
            cell.show(image)
            let visible = visibleContent
            if tops.indices.contains(index) {
                cell.reveal(CGRect(x: 0, y: visible.minY - visible.height - tops[index], width: laidOutWidth, height: visible.height * 3), retaining: zoomInProgress)
            }
        }
        // ImageIO rounds downsampled dimensions. A quality upgrade is the same page,
        // not new layout metadata; it must never resize the strip again.
        if image.size.height > 0, measuredImages.insert(pages[index].key).inserted {
            setAspect(image.size.width / image.size.height, at: index)
        }
    }

    private func distanceFromScreen(_ index: Int) -> Double {
        let zoom = scrollView.zoomScale
        let top = tops[index] * zoom - scrollView.contentOffset.y, bottom = top + heights[index] * zoom
        let height = scrollView.bounds.height
        return Double(bottom < 0 ? -bottom : top > height ? top - height : 0)
    }

    // MARK: scrolling and zooming

    public func viewForZooming(in scrollView: UIScrollView) -> UIView? { content }

    public func scrollViewDidScroll(_ scrollView: UIScrollView) { FrameMonitor.shared.measure("strip.scroll") { updateVisible() } }

    private var monitoring = false
    private func monitor(_ moving: Bool) {
        guard moving != monitoring else { return }
        monitoring = moving
        FrameMonitor.shared.scrolling(moving)
    }

    public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) { monitor(true) }

    public func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
        pinchQuality = zoomBucket
        zoomInProgress = true
        pinnedTop = nil
        monitor(true)
    }

    public func scrollViewDidZoom(_ scrollView: UIScrollView) {
        // Keep a page narrower than the screen centred horizontally (zooming out bounces).
        let offsetX = max(0, (scrollView.bounds.width - scrollView.contentSize.width) / 2)
        content.center.x = scrollView.contentSize.width / 2 + offsetX
        updateVisible()
    }

    public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        pinnedTop = nil
        if !decelerate { monitor(false); settleIfIdle() }
    }
    public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { monitor(false); settleIfIdle() }
    public func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
        zoomInProgress = false
        let anchor = screenAnchor
        let changed = !pendingAspects.isEmpty || pendingAppend
        for (index, aspect) in pendingAspects where pages.indices.contains(index) { pages[index].aspect = aspect }
        pendingAspects = [:]
        pendingAppend = false
        let ready = pendingImages
        pendingImages = [:]
        for (index, image) in ready {
            if let cell = cells[index] { show(image, at: index, cell: cell) }
        }
        if changed { relayout(keeping: nil, screen: anchor) }
        updateVisible()
        monitor(scrollView.isDragging || scrollView.isDecelerating)
        settleIfIdle()
    }
    public func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { settleIfIdle() }

    private func settleIfIdle() {
        guard !touching, !zoomInProgress, !scrollView.isDragging, !scrollView.isDecelerating, !scrollView.isZooming, let position = currentPosition else { return }
        delegate?.strip(self, settledAt: position)
    }

    public var isZoomed: Bool { zoomInProgress || scrollView.zoomScale > 1.01 }

    @objc private func doubleTapped(_ tap: UITapGestureRecognizer) {
        if isZoomed { scrollView.setZoomScale(1, animated: true); return }
        let point = tap.location(in: content)
        let scale: CGFloat = 2.5
        let size = CGSize(width: scrollView.bounds.width / scale, height: scrollView.bounds.height / scale)
        scrollView.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }

    public var state: [String: Any] {
        ["pages": pages.count, "decoded": cells.values.filter(\.hasImage).count,
         "position": currentPosition.map { ["index": $0.index, "fraction": $0.fraction] } ?? [:],
         "zoom": scrollView.zoomScale, "failures": failures.count]
    }
}

@MainActor
final class PageCell: UIView {
    // A page taller than this many pixels is drawn in slices of `slice` pixels, each its own
    // layer, attached only near the screen: Core Animation then prepares a few megabytes as they
    // come into view instead of a whole page (Asura's 900×16000 pages are 57 MB) in one frame.
    static let tallest = 2048
    static let slice = 1024

    let imageView = UIImageView()
    private let message = UILabel()
    private var slices: [CGImage] = []
    // Each slice made ready for display off the main thread (preparingForDisplay), so attaching
    // it costs the commit nothing; one not ready yet is attached as it is.
    private var prepared: [Int: UIImage] = [:]
    private var preparing: Task<Void, Never>?
    private var generation = 0
    private var sliceScale: CGFloat = 1
    private var sliceViews: [Int: UIImageView] = [:]
    private var pixelHeight = 0
    var index = -1
    var ticket: ImageTicket?
    var fit: ImageFit?
    private(set) var hasImage = false

    init() {
        super.init(frame: .zero)
        backgroundColor = .black
        clipsToBounds = true
        imageView.contentMode = .scaleAspectFit
        imageView.backgroundColor = .black
        addSubview(imageView)
        message.textColor = UIColor(white: 0.73, alpha: 1)
        message.font = .systemFont(ofSize: 14)
        message.numberOfLines = 0
        message.isHidden = true
        addSubview(message)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override func layoutSubviews() {
        super.layoutSubviews()
        imageView.frame = bounds
        for (slice, view) in sliceViews { view.frame = frame(ofSlice: slice) }
        message.frame = bounds.insetBy(dx: 8, dy: 8)
        message.sizeToFit()
        message.frame.origin = CGPoint(x: 8, y: 8)
    }

    private func frame(ofSlice slice: Int) -> CGRect {
        guard pixelHeight > 0 else { return .zero }
        let top = CGFloat(slice * Self.slice) / CGFloat(pixelHeight) * bounds.height
        let bottom = CGFloat(min(pixelHeight, (slice + 1) * Self.slice)) / CGFloat(pixelHeight) * bounds.height
        return CGRect(x: 0, y: top, width: bounds.width, height: bottom - top)
    }

    func show(_ image: UIImage) {
        clearSlices()
        message.isHidden = true
        hasImage = true
        guard let cgImage = image.cgImage, cgImage.height > Self.tallest else {
            imageView.isHidden = false
            imageView.image = image
            return
        }
        // Full-width slices: cropping shares the decoded pixels (no copy until shown).
        imageView.image = nil
        imageView.isHidden = true
        pixelHeight = cgImage.height
        sliceScale = image.scale
        slices = stride(from: 0, to: cgImage.height, by: Self.slice).compactMap { y in
            cgImage.cropping(to: CGRect(x: 0, y: y, width: cgImage.width, height: min(Self.slice, cgImage.height - y)))
        }
        generation += 1
        let generation = generation, slices = slices, scale = sliceScale
        preparing = Task.detached(priority: .utility) { [weak self] in
            for (index, slice) in slices.enumerated() {
                if Task.isCancelled { return }
                guard let ready = UIImage(cgImage: slice, scale: scale, orientation: .up).preparingForDisplay() else { continue }
                await MainActor.run { [weak self] in
                    guard let self, self.generation == generation else { return }
                    self.prepared[index] = ready
                    // Already attached as it was: swap in the ready one (same pixels).
                    self.sliceViews[index]?.image = ready
                }
            }
        }
    }

    // The part of the page near the screen, in the cell's coordinates: its slices are attached.
    func reveal(_ near: CGRect, retaining: Bool = false) {
        guard !slices.isEmpty, bounds.height > 0 else { return }
        for slice in slices.indices {
            let frame = frame(ofSlice: slice)
            if frame.intersects(near) {
                guard sliceViews[slice] == nil else { continue }
                let view = UIImageView(image: prepared[slice] ?? UIImage(cgImage: slices[slice], scale: sliceScale, orientation: .up))
                view.contentMode = .scaleToFill
                view.frame = frame
                insertSubview(view, belowSubview: message)
                sliceViews[slice] = view
            } else if !retaining, let view = sliceViews.removeValue(forKey: slice) {
                view.removeFromSuperview()
            }
        }
    }

    private func clearSlices() {
        preparing?.cancel()
        preparing = nil
        generation += 1
        prepared = [:]
        for view in sliceViews.values { view.removeFromSuperview() }
        sliceViews = [:]
        slices = []
        pixelHeight = 0
    }

    func showFailure(_ text: String?) {
        message.text = text
        message.isHidden = text == nil
        setNeedsLayout()
    }

    func reset() {
        clearSlices()
        imageView.image = nil
        imageView.isHidden = false
        hasImage = false
        message.isHidden = true
        ticket = nil
        fit = nil
        index = -1
    }
}

// Reports whether a finger is down, without taking part in any gesture.
final class TouchTracker: UIGestureRecognizer, UIGestureRecognizerDelegate {
    private let changed: (Bool) -> Void
    private var count = 0

    init(_ changed: @escaping (Bool) -> Void) {
        self.changed = changed
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
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

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
#endif
