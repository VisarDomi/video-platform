#if canImport(UIKit) && targetEnvironment(simulator)
import Network
import UIKit
import KitCore

// Drives a simulator build from the Mac, where UI tests cannot run (this Xcode lacks the
// simulator's Swift Testing interop library) and WebDriverAgent cannot be built: a tiny HTTP
// server on localhost:8765 (simulator builds only; nothing of this exists on the phone).
//
//   curl localhost:8765/state                      debug state (DebugState) as JSON
//   curl localhost:8765/tap?x=50&y=400             a tap at window points: controls, collection
//                                                  cells, table cells
//   curl localhost:8765/scroll?y=1200[&x=0]        the frontmost vertical scroll view's offset
//   curl 'localhost:8765/scroll?y=10&at=50,400'    the scroll view under a point
//   curl localhost:8765/back | /forward            the navigation stack
//   curl localhost:8765/zoom?scale=2.5             the frontmost zooming scroll view
//   curl localhost:8765/action?name=...            an app-registered action
//   curl localhost:8765/layout                     what is on screen, as positions (see Layout)
//   curl localhost:8765/timeline                   the layout at the first frames after launch
// Every answer is JSON; screenshots come from `xcrun simctl io booted screenshot`.
@MainActor
public final class TestHooks {
    public static let shared = TestHooks()
    private var listener: NWListener?
    private var actions: [String: ([String: String]) -> Any] = [:]
    public var back: (() -> Void)?
    public var forward: (() -> Void)?
    private var timeline: [[String: Any]] = []
    private var displayLink: CADisplayLink?
    private var launched = CACurrentMediaTime()
    private var firstFrame: CFTimeInterval?
    private var samples: [Double] = []

    public func register(_ name: String, _ action: @escaping ([String: String]) -> Any) { actions[name] = action }

    public func start(port: UInt16 = 8765) {
        guard listener == nil, let port = NWEndpoint.Port(rawValue: port) else { return }
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
        parameters.allowLocalEndpointReuse = true
        guard let listener = try? NWListener(using: parameters) else { return }
        listener.newConnectionHandler = { connection in
            connection.start(queue: .main)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { data, _, _, _ in
                let request = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
                MainActor.assumeIsolated {
                    let body = TestHooks.shared.answer(request)
                    let payload = (try? JSONSerialization.data(withJSONObject: body, options: [.prettyPrinted, .sortedKeys])) ?? Data("{}".utf8)
                    let head = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n"
                    connection.send(content: Data(head.utf8) + payload, completion: .contentProcessed { _ in connection.cancel() })
                }
            }
        }
        listener.start(queue: .main)
        self.listener = listener
        Log.app.info("Test hooks listening on 127.0.0.1:\(port.rawValue)")
        recordLaunch()
    }

    // The layout at the first frame that shows the app's screen and at fixed times after it, so a
    // relaunch can be compared with the screen as it was left (a restore is exact when the first
    // sample already matches).
    private func recordLaunch() {
        launched = CACurrentMediaTime()
        samples = [0, 0.1, 0.25, 0.5, 1, 2, 4, 8]
        let link = CADisplayLink(target: LinkTarget { [weak self] in self?.tick() }, selector: #selector(LinkTarget.fire))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func tick() {
        let now = CACurrentMediaTime()
        guard let window, window.rootViewController?.viewIfLoaded?.window != nil else { return }
        let first = firstFrame ?? now
        firstFrame = first
        guard let next = samples.first, now - first >= next else { return }
        samples.removeFirst()
        timeline.append(["sinceLaunch": Int((now - launched) * 1000), "sinceFirstFrame": Int((now - first) * 1000), "layout": Layout.capture(window)])
        if samples.isEmpty { displayLink?.invalidate(); displayLink = nil }
    }

    private func answer(_ request: String) -> Any {
        let line = request.split(separator: "\r\n").first.map(String.init) ?? ""
        let target = line.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
        let components = URLComponents(string: "http://hooks" + target)
        let query = Dictionary((components?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { $1 })
        switch components?.path ?? "/" {
        case "/state": return DebugState.shared.snapshot()
        case "/tap": return tap(CGPoint(x: Double(query["x"] ?? "") ?? 0, y: Double(query["y"] ?? "") ?? 0))
        case "/scroll": return scroll(query)
        case "/zoom": return zoom(CGFloat(Double(query["scale"] ?? "") ?? 1))
        case "/layout": return window.map { ["layout": Layout.capture($0)] } ?? ["error": "no window"]
        case "/timeline": return ["timeline": timeline]
        case "/back": back?(); return ["ok": true]
        case "/forward": forward?(); return ["ok": true]
        case "/action":
            guard let name = query["name"], let action = actions[name] else { return ["error": "unknown action", "actions": actions.keys.sorted()] }
            return action(query)
        default: return ["error": "unknown path"]
        }
    }

    private var window: UIWindow? {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first { $0.isKeyWindow }
    }

    private func tap(_ point: CGPoint) -> Any {
        guard let window, let hit = window.hitTest(point, with: nil) else { return ["error": "nothing at point"] }
        var view: UIView? = hit
        while let current = view {
            if let control = current as? UIControl, control.isEnabled {
                control.sendActions(for: .touchUpInside)
                return ["tapped": String(describing: type(of: control))]
            }
            if let cell = current as? UICollectionViewCell, let collection = current.superview(of: UICollectionView.self),
               let indexPath = collection.indexPath(for: cell) {
                collection.delegate?.collectionView?(collection, didSelectItemAt: indexPath)
                return ["tapped": "cell", "item": indexPath.item]
            }
            if let cell = current as? UITableViewCell, let table = current.superview(of: UITableView.self), let indexPath = table.indexPath(for: cell) {
                table.delegate?.tableView?(table, didSelectRowAt: indexPath)
                return ["tapped": "row", "row": indexPath.row]
            }
            view = current.superview
        }
        return ["error": "nothing tappable", "view": String(describing: type(of: hit))]
    }

    private func scroll(_ query: [String: String]) -> Any {
        guard let window else { return ["error": "no window"] }
        var scrollView: UIScrollView?
        if let at = query["at"]?.split(separator: ",").compactMap({ Double($0) }), at.count == 2 {
            scrollView = window.hitTest(CGPoint(x: at[0], y: at[1]), with: nil)?.superview(of: UIScrollView.self, includingSelf: true)
        } else {
            scrollView = window.frontmostScrollView(vertical: query["x"] == nil)
        }
        guard let scrollView else { return ["error": "no scroll view"] }
        let x = query["x"].flatMap(Double.init).map { CGFloat($0) } ?? scrollView.contentOffset.x
        let y = query["y"].flatMap(Double.init).map { CGFloat($0) } ?? scrollView.contentOffset.y
        scrollView.setContentOffset(CGPoint(x: x, y: y), animated: false)
        // The end of a scroll, as a finger lifting with no momentum would report it.
        scrollView.delegate?.scrollViewDidEndDragging?(scrollView, willDecelerate: false)
        return ["offset": ["x": scrollView.contentOffset.x, "y": scrollView.contentOffset.y], "content": ["w": scrollView.contentSize.width, "h": scrollView.contentSize.height]]
    }

    private func zoom(_ scale: CGFloat) -> Any {
        guard let scrollView = window?.frontmostScrollView(vertical: true, zooming: true) else { return ["error": "no zooming scroll view"] }
        scrollView.setZoomScale(scale, animated: false)
        scrollView.delegate?.scrollViewDidEndZooming?(scrollView, with: nil, atScale: scrollView.zoomScale)
        return ["zoom": scrollView.zoomScale]
    }
}

private final class LinkTarget: NSObject {
    let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func fire() { action() }
}

// What is on screen, as positions: each visible label (its text), text view, image view (whether
// it shows an image) and video layer (whether it shows a picture), front to back, with the part
// of it that is visible (clipped by its scrolling and clipping ancestors) in window points,
// rounded to a quarter point. Two captures are equal when the screen looks the same, apart from
// the images' contents.
@MainActor
enum Layout {
    static func capture(_ window: UIWindow) -> [[String: Any]] {
        var items: [[String: Any]] = []
        func visit(_ view: UIView, clip: CGRect) {
            guard !view.isHidden, view.alpha > 0.01 else { return }
            let frame = view.convert(view.bounds, to: window)
            let visible = frame.intersection(clip)
            guard !visible.isNull, visible.width > 0.5, visible.height > 0.5 else { return }
            var item: [String: Any]?
            if let label = view as? UILabel, let text = label.text, !text.isEmpty {
                item = ["kind": "label", "text": text]
            } else if let text = view as? UITextView {
                item = ["kind": "text", "text": text.text ?? ""]
            } else if let image = view as? UIImageView, !(view.superview is UIButton) {
                item = ["kind": "image", "shown": image.image != nil]
            } else if NSStringFromClass(type(of: view.layer)) == "AVPlayerLayer" {
                // AVPlayerLayer's readiness without linking AVFoundation into every app.
                item = ["kind": "video", "shown": (view.layer.value(forKey: "readyForDisplay") as? Bool) ?? false]
            }
            if var item {
                item["frame"] = [visible.minX, visible.minY, visible.width, visible.height].map { ($0 * 4).rounded() / 4 }
                items.append(item)
            }
            let inner = view.clipsToBounds || view is UIScrollView ? visible : clip
            for subview in view.subviews { visit(subview, clip: inner) }
        }
        visit(window, clip: window.bounds)
        return items
    }
}

private extension UIView {
    func superview<T: UIView>(of type: T.Type, includingSelf: Bool = false) -> T? {
        var view: UIView? = includingSelf ? self : superview
        while let current = view {
            if let match = current as? T { return match }
            view = current.superview
        }
        return nil
    }

    // The largest visible scroll view (scrolling vertically when asked), searching from the top.
    func frontmostScrollView(vertical: Bool, zooming: Bool = false) -> UIScrollView? {
        var best: UIScrollView?
        func visit(_ view: UIView) {
            guard !view.isHidden, view.alpha > 0.01, view is UIWindow || view.window != nil else { return }
            if let scroll = view as? UIScrollView, !(vertical && scroll.contentSize.height <= scroll.bounds.height + 1 && !zooming),
               !zooming || scroll.maximumZoomScale > 1 {
                let area = scroll.bounds.width * scroll.bounds.height
                if area >= (best.map { $0.bounds.width * $0.bounds.height } ?? 0) { best = scroll }
            }
            view.subviews.forEach(visit)
        }
        visit(self)
        return best
    }
}
#endif
