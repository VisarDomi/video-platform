#if canImport(UIKit)
import UIKit

// A list position that survives layout changes and relaunches: the item at the focal line (the
// screen's middle) and how far down that item the line is. Pixel offsets break as soon as a
// row above changes height or the screen rotates; an anchor does not.
public struct ScrollAnchor: Codable, Sendable, Equatable {
    public var key: String
    public var fraction: Double
    public init(key: String, fraction: Double) {
        self.key = key
        self.fraction = min(max(fraction.isFinite ? fraction : 0, 0), 1)
    }
}

@MainActor
public enum ScrollAnchoring {
    // The anchor at the scroll view's vertical middle, given each item's frame in the scroll
    // view's content coordinates.
    public static func anchor(in scrollView: UIScrollView, items: [(key: String, frame: CGRect)]) -> ScrollAnchor? {
        let line = scrollView.contentOffset.y + scrollView.bounds.height / 2
        guard let hit = items.first(where: { $0.frame.minY <= line && line < $0.frame.maxY })
                ?? items.min(by: { abs($0.frame.midY - line) < abs($1.frame.midY - line) }) else { return nil }
        return ScrollAnchor(key: hit.key, fraction: Double((line - hit.frame.minY) / max(hit.frame.height, 1)))
    }

    // Scrolls so the anchor is back at the middle; false when the item is not in `frame`. It needs
    // no layout first: a list restored before its first layout builds only the rows at the
    // anchor (their images are the ones decoded for the first frame), not those at the top.
    @discardableResult
    public static func restore(_ anchor: ScrollAnchor, in scrollView: UIScrollView, frame: CGRect?) -> Bool {
        guard let frame else { return false }
        let line = frame.minY + frame.height * anchor.fraction
        // Before the first layout the content size is not known yet: no end to keep within.
        let maxOffset = scrollView.contentSize.height <= 0 ? CGFloat.greatestFiniteMagnitude : max(-scrollView.adjustedContentInset.top,
                            scrollView.contentSize.height + scrollView.adjustedContentInset.bottom - scrollView.bounds.height)
        let y = min(max(-scrollView.adjustedContentInset.top, line - scrollView.bounds.height / 2), maxOffset)
        scrollView.contentOffset = CGPoint(x: scrollView.contentOffset.x, y: y)
        return true
    }
}
#endif
