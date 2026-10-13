#if canImport(UIKit)
import UIKit
import KitCore

// A screen in the live stack. Screens below the top stay alive (their views, scroll offsets,
// loaded images), which is what WebKit's back-forward cache gave by chance and may drop:
// here going back is always instant and exact. Each screen describes itself as a route
// (where it is) and a state (how it looked), saved continuously so a relaunch rebuilds the
// whole stack, not only the top screen.
@MainActor
public protocol LiveScreen: UIViewController {
    // Codable description of the screen's place (a list page, a gallery's reader).
    var route: Data { get }
    // The screen's own state (scroll anchor, strip offsets), nil when it has none.
    func savedState() -> Data?
    // false while the screen owns the left edge (a zoomed picture pans there).
    var allowsEdgeBack: Bool { get }
}

public extension LiveScreen {
    var allowsEdgeBack: Bool { true }
    // Call when the screen's state changed (a scroll settled); the stack is saved soon after.
    func stateChanged() { (navigationController as? LiveNavigationController)?.screenChanged() }
    var liveNavigation: LiveNavigationController? { navigationController as? LiveNavigationController }
}

public struct SavedStack: Codable, Sendable, Equatable {
    public struct Entry: Codable, Sendable, Equatable {
        public var route: Data
        public var state: Data?
        public init(route: Data, state: Data?) { self.route = route; self.state = state }
    }
    public var back: [Entry]
    public var forward: [Entry]
    public init(back: [Entry] = [], forward: [Entry] = []) { self.back = back; self.forward = forward }
}

// The app's navigation: no bars, the left edge goes back (interactive, like Safari), the
// right edge goes forward to the screen last left by going back, and a new screen clears the
// forward list, as in a browser. The stack (both directions) is written to `file` whenever
// it or a screen's state changes, and flushed when the app may be suspended.
@MainActor
public final class LiveNavigationController: UINavigationController, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
    public typealias Factory = (_ route: Data, _ state: Data?) -> (any LiveScreen)?

    private let writer: BackgroundWriter
    private let factory: Factory
    private var forward: [any LiveScreen] = []
    private var savedForward: [SavedStack.Entry] = []
    private var forwardPan: UIScreenEdgePanGestureRecognizer!
    private var interactiveForward: UIPercentDrivenInteractiveTransition?
    private var pushingForward = false
    private var saveScheduled = false
    private var warmed = false

    public init(file: URL, factory: @escaping Factory, root: @autoclosure () -> any LiveScreen) {
        writer = BackgroundWriter(url: file, label: "kit-navigation")
        self.factory = factory
        let saved = (try? DurableFile.readJSON(SavedStack.self, from: file)) ?? SavedStack()
        let screens = saved.back.compactMap { factory($0.route, $0.state) }
        super.init(nibName: nil, bundle: nil)
        setViewControllers(screens.isEmpty ? [root()] : screens, animated: false)
        savedForward = saved.forward
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    public var screens: [any LiveScreen] { viewControllers.compactMap { $0 as? any LiveScreen } }
    public var canGoForward: Bool { !forward.isEmpty || !savedForward.isEmpty }

    override public func viewDidLoad() {
        super.viewDidLoad()
        setNavigationBarHidden(true, animated: false)
        delegate = self
        interactivePopGestureRecognizer?.delegate = self
        forwardPan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(forwardPanned(_:)))
        forwardPan.edges = .right
        forwardPan.delegate = self
        view.addGestureRecognizer(forwardPan)
    }

    // After a relaunch the screens below the top are built too, off screen at the screen's size,
    // once the top one is showing: going back then reveals them complete (their images already
    // asked for), not filling in during the swipe.
    override public func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !warmed else { return }
        warmed = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for screen in viewControllers.dropLast() where !screen.isViewLoaded {
                screen.loadViewIfNeeded()
                screen.view.frame = view.bounds
                screen.view.setNeedsLayout()
                screen.view.layoutIfNeeded()
            }
        }
    }

    override public var childForStatusBarHidden: UIViewController? { topViewController }
    override public var childForHomeIndicatorAutoHidden: UIViewController? { topViewController }

    // A new place: the forward list is gone, as after following a link.
    public func open(_ screen: any LiveScreen, animated: Bool = true) {
        forward.removeAll()
        savedForward.removeAll()
        pushViewController(screen, animated: animated)
    }

    // Replaces the top screen (a page change that adds no history entry).
    public func replaceTop(with screen: any LiveScreen) {
        var stack = viewControllers
        if stack.isEmpty { stack = [screen] } else { stack[stack.count - 1] = screen }
        setViewControllers(stack, animated: false)
        screenChanged()
    }

    public func goForward(animated: Bool = true) {
        guard let screen = takeForward() else { return }
        pushingForward = true
        pushViewController(screen, animated: animated)
    }

    func screenChanged() {
        guard !saveScheduled else { return }
        saveScheduled = true
        // Coalesce a burst of changes into one save on the next turn of the run loop.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            saveScheduled = false
            save()
        }
    }

    public func save() {
        FrameMonitor.shared.measure("navigation.save") { saveNow() }
    }

    private func saveNow() {
        let stack = SavedStack(back: screens.map { SavedStack.Entry(route: $0.route, state: $0.savedState()) },
                               forward: forward.reversed().map { SavedStack.Entry(route: $0.route, state: $0.savedState()) }.reversed() + savedForward)
        writer.save(json: stack)
    }

    // Before the app may be suspended.
    public func flush() {
        save()
        writer.flush()
    }

    private func takeForward() -> (any LiveScreen)? {
        if let screen = forward.popLast() { return screen }
        while let entry = savedForward.first {
            savedForward.removeFirst()
            if let screen = factory(entry.route, entry.state) { return screen }
        }
        return nil
    }

    // MARK: going back keeps the screen for going forward

    public func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) {
        // A screen that left the stack by going back becomes the next forward screen.
        if let coordinator = transitionCoordinator, coordinator.isCancelled { return }
        screenChanged()
    }

    override public func popViewController(animated: Bool) -> UIViewController? {
        let popped = super.popViewController(animated: animated)
        guard let screen = popped as? any LiveScreen else { return popped }
        if let coordinator = transitionCoordinator {
            coordinator.animate(alongsideTransition: nil) { [weak self] context in
                if !context.isCancelled { self?.forward.append(screen) }
            }
        } else {
            forward.append(screen)
        }
        return popped
    }

    // Going back several screens at once keeps them all for going forward, in order.
    override public func popToViewController(_ viewController: UIViewController, animated: Bool) -> [UIViewController]? {
        let popped = super.popToViewController(viewController, animated: animated)
        keepForward(popped)
        return popped
    }

    override public func popToRootViewController(animated: Bool) -> [UIViewController]? {
        let popped = super.popToRootViewController(animated: animated)
        keepForward(popped)
        return popped
    }

    private func keepForward(_ popped: [UIViewController]?) {
        let screens = (popped ?? []).compactMap { $0 as? any LiveScreen }
        guard !screens.isEmpty else { return }
        if let coordinator = transitionCoordinator {
            coordinator.animate(alongsideTransition: nil) { [weak self] context in
                if !context.isCancelled { self?.forward.append(contentsOf: screens.reversed()) }
            }
        } else {
            forward.append(contentsOf: screens.reversed())
        }
    }

    // MARK: gestures

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === interactivePopGestureRecognizer {
            guard viewControllers.count > 1, transitionCoordinator == nil else { return false }
            return (topViewController as? any LiveScreen)?.allowsEdgeBack ?? true
        }
        if gestureRecognizer === forwardPan {
            return canGoForward && transitionCoordinator == nil
        }
        return true
    }

    // The edges win over scrolling content (a strip that starts at the screen's edge), as in Safari.
    public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        (gestureRecognizer === interactivePopGestureRecognizer || gestureRecognizer === forwardPan) && other is UIPanGestureRecognizer
            && !(other is UIScreenEdgePanGestureRecognizer)
    }

    @objc private func forwardPanned(_ pan: UIScreenEdgePanGestureRecognizer) {
        let width = max(view.bounds.width, 1)
        let progress = min(max(-pan.translation(in: view).x / width, 0), 1)
        switch pan.state {
        case .began:
            guard let screen = takeForward() else { return }
            interactiveForward = UIPercentDrivenInteractiveTransition()
            pushingForward = true
            pushViewController(screen, animated: true)
        case .changed:
            interactiveForward?.update(progress)
        case .ended:
            let velocity = -pan.velocity(in: view).x
            if progress > 0.33 || velocity > 600 { interactiveForward?.finish() } else { interactiveForward?.cancel() }
            interactiveForward = nil
        default:
            interactiveForward?.cancel()
            interactiveForward = nil
        }
    }

    public func navigationController(_ navigationController: UINavigationController,
                                     interactionControllerFor animationController: any UIViewControllerAnimatedTransitioning)
        -> (any UIViewControllerInteractiveTransitioning)? {
        animationController is ForwardPush ? interactiveForward : nil
    }

    public func navigationController(_ navigationController: UINavigationController, animationControllerFor operation: UINavigationController.Operation,
                                     from fromVC: UIViewController, to toVC: UIViewController) -> (any UIViewControllerAnimatedTransitioning)? {
        guard operation == .push, pushingForward else { return nil }
        pushingForward = false
        return ForwardPush(onCancel: { [weak self] in
            if let screen = toVC as? any LiveScreen { self?.forward.append(screen) }
        })
    }
}

// The forward push follows the finger from the right edge, the mirror of the system's back.
@MainActor
final class ForwardPush: NSObject, UIViewControllerAnimatedTransitioning {
    private let onCancel: () -> Void
    init(onCancel: @escaping () -> Void) { self.onCancel = onCancel }

    nonisolated func transitionDuration(using context: (any UIViewControllerContextTransitioning)?) -> TimeInterval { 0.3 }

    nonisolated func animateTransition(using context: any UIViewControllerContextTransitioning) {
        MainActor.assumeIsolated {
            guard let from = context.viewController(forKey: .from), let to = context.viewController(forKey: .to) else {
                context.completeTransition(false)
                return
            }
            let container = context.containerView
            let width = container.bounds.width
            to.view.frame = context.finalFrame(for: to).offsetBy(dx: width, dy: 0)
            to.view.layer.shadowColor = UIColor.black.cgColor
            to.view.layer.shadowOpacity = 0.4
            to.view.layer.shadowRadius = 10
            container.addSubview(to.view)
            UIView.animate(withDuration: transitionDuration(using: context), delay: 0, options: context.isInteractive ? .curveLinear : .curveEaseOut) {
                to.view.frame = context.finalFrame(for: to)
                from.view.frame = from.view.frame.offsetBy(dx: -width * 0.3, dy: 0)
            } completion: { _ in
                to.view.layer.shadowOpacity = 0
                from.view.frame = context.initialFrame(for: from)
                let cancelled = context.transitionWasCancelled
                if cancelled { to.view.removeFromSuperview(); self.onCancel() }
                context.completeTransition(!cancelled)
            }
        }
    }
}
#endif
