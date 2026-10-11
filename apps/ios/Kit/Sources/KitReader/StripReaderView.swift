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
}

public extension StripReaderDelegate {
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
        let anchor = currentPosition
        pages += more
        relayout(keeping: anchor)
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

    // A page's real size became known; the page at the centre keeps its place.
    public func setAspect(_ aspect: CGFloat, at index: Int) {
        guard pages.indices.contains(index), aspect.isFinite, aspect > 0 else { return }
        if let known = pages[index].aspect, abs(known - aspect) < 0.0001 { return }
        let anchor = currentPosition
        pages[index].aspect = aspect
        relayout(keeping: anchor)
    }

    // MARK: position

    public var currentPosition: StripPosition? { laidOutWidth > 0 ? position(atContentY: centreContentY) : nil }

    // Puts `position` at the screen's centre (applied after the first layout if needed).
    public func scroll(to position: StripPosition) {
        guard laidOutWidth > 0, pages.indices.contains(position.index) else { pendingPosition = position; pendingTop = nil; pinnedTop = nil; return }
        pendingPosition = nil
        pendingTop = nil
        pinnedTop = nil
        let y = tops[position.index] + heights[position.index] * position.fraction
        setCentre(contentY: y)
    }

    // Puts a page's top at the top of the screen (a resumed page, read from its start).
    public func scroll(toTopOf index: Int) {
        guard laidOutWidth > 0, pages.indices.contains(index) else {
            if pages.indices.contains(index) { pendingTop = index }
            return
        }
        pendingTop = nil
        pendingPosition = nil
        pinnedTop = index
        setCentre(contentY: tops[index] + bounds.height / 2 / scrollView.zoomScale)
    }

    private var centreContentY: CGFloat { (scrollView.contentOffset.y + scrollView.bounds.height / 2) / scrollView.zoomScale }

    private func position(atContentY y: CGFloat) -> StripPosition? {
        guard !pages.isEmpty, tops.count == pages.count else { return nil }
        let index = pageIndex(atContentY: y)
        return StripPosition(index: index, fraction: Double((y - tops[index]) / max(heights[index], 1)))
    }

    private func setCentre(contentY y: CGFloat) {
        let zoom = scrollView.zoomScale
        let maxOffset = max(0, scrollView.contentSize.height - scrollView.bounds.height)
        let offsetY = min(max(0, y * zoom - scrollView.bounds.height / 2), maxOffset)
        scrollView.contentOffset = CGPoint(x: scrollView.contentOffset.x, y: offsetY)
    }

    // The page containing content y (clamped to the first and last page).
    private func pageIndex(atContentY y: CGFloat) -> Int {
        var low = 0, high = pages.count - 1
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
        scrollView.frame = bounds
        if bounds.width != laidOutWidth { relayout(keeping: anchor) }
        if let pendingPosition { scroll(to: pendingPosition) }
        if let pendingTop { scroll(toTopOf: pendingTop) }
        updateVisible()
    }

    private var padding: CGFloat { bounds.height / 2 }

    private func relayout(keeping anchor: StripPosition?) {
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
        if let pinnedTop, pages.indices.contains(pinnedTop) { setCentre(contentY: tops[pinnedTop] + bounds.height / 2 / scrollView.zoomScale) }
        else if let anchor, pages.indices.contains(anchor.index) { scroll(to: anchor) }
        updateVisible()
    }

    private func frame(of index: Int) -> CGRect { CGRect(x: 0, y: tops[index], width: laidOutWidth, height: heights[index]) }

    // MARK: visible pages

    private func updateVisible() {
        guard !pages.isEmpty, laidOutWidth > 0 else { return }
        let zoom = scrollView.zoomScale
        let visibleTop = scrollView.contentOffset.y / zoom, visibleHeight = scrollView.bounds.height / zoom
        let margin = visibleHeight * preloadScreens
        let first = pageIndex(atContentY: visibleTop - margin), last = pageIndex(atContentY: visibleTop + visibleHeight + margin)
        let wanted = Set(first...last)
        for (index, cell) in cells where !wanted.contains(index) {
            recycle(cell)
            cells[index] = nil
        }
        let widthPixels = Int((laidOutWidth * zoomBucket * (window?.screen.scale ?? 3)).rounded(.up))
        for index in first...last {
            let cell = cells[index] ?? dequeue(index)
            if cell.fit != .width(widthPixels) || (cell.imageView.image == nil && cell.ticket == nil && retryDue(index)) { request(index, cell: cell, width: widthPixels) }
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
        let request = ImagePipeline.Request(key: key, source: delegate.strip(self, sourceFor: index), fit: .width(width)) { [weak self] in
            guard let self, self.pages.indices.contains(index) else { return .infinity }
            return self.distanceFromScreen(index)
        }
        cell.ticket = pipeline.load(request) { [weak self, weak cell] result in
            guard let self, let cell, cell.index == index else { return }
            cell.ticket = nil
            switch result {
            case .success(let image):
                failures[index] = nil
                cell.show(image)
                if image.size.height > 0 { setAspect(image.size.width / image.size.height, at: index) }
            case .failure(let error):
                if error is CancellationError { return }
                let attempts = (failures[index]?.attempts ?? 0) + 1
                failures[index] = (attempts, CACurrentMediaTime() + min(30, pow(2, Double(attempts - 1))))
                cell.showFailure(self.delegate?.strip(self, failureTextFor: index, error: error))
                DispatchQueue.main.asyncAfter(deadline: .now() + min(30, pow(2, Double(attempts - 1)))) { [weak self] in self?.updateVisible() }
            }
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

    public func scrollViewDidScroll(_ scrollView: UIScrollView) { updateVisible() }

    public func scrollViewDidZoom(_ scrollView: UIScrollView) {
        // Keep a page narrower than the screen centred horizontally (zooming out bounces).
        let offsetX = max(0, (scrollView.bounds.width - scrollView.contentSize.width) / 2)
        content.center.x = scrollView.contentSize.width / 2 + offsetX
        updateVisible()
    }

    public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        pinnedTop = nil
        if !decelerate { settleIfIdle() }
    }
    public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { settleIfIdle() }
    public func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) { settleIfIdle() }
    public func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { settleIfIdle() }

    private func settleIfIdle() {
        guard !touching, !scrollView.isDragging, !scrollView.isDecelerating, !scrollView.isZooming, let position = currentPosition else { return }
        delegate?.strip(self, settledAt: position)
    }

    public var isZoomed: Bool { scrollView.zoomScale > 1.01 }

    @objc private func doubleTapped(_ tap: UITapGestureRecognizer) {
        if isZoomed { scrollView.setZoomScale(1, animated: true); return }
        let point = tap.location(in: content)
        let scale: CGFloat = 2.5
        let size = CGSize(width: scrollView.bounds.width / scale, height: scrollView.bounds.height / scale)
        scrollView.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
    }

    public var state: [String: Any] {
        ["pages": pages.count, "decoded": cells.values.filter { $0.imageView.image != nil }.count,
         "position": currentPosition.map { ["index": $0.index, "fraction": $0.fraction] } ?? [:],
         "zoom": scrollView.zoomScale, "failures": failures.count]
    }
}

@MainActor
final class PageCell: UIView {
    let imageView = UIImageView()
    private let message = UILabel()
    var index = -1
    var ticket: ImageTicket?
    var fit: ImageFit?

    init() {
        super.init(frame: .zero)
        backgroundColor = .black
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
        message.frame = bounds.insetBy(dx: 8, dy: 8)
        message.sizeToFit()
        message.frame.origin = CGPoint(x: 8, y: 8)
    }

    func show(_ image: UIImage) {
        imageView.image = image
        message.isHidden = true
    }

    func showFailure(_ text: String?) {
        message.text = text
        message.isHidden = text == nil
        setNeedsLayout()
    }

    func reset() {
        imageView.image = nil
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
