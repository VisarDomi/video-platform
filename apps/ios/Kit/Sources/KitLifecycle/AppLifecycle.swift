#if canImport(UIKit)
import UIKit
import KitCore

// The app's trips away from the screen, told apart as the apps need them: resigning active
// (Control Center, Face ID, a banner, the app switcher, locking) only saves and hands work to
// iOS; a real trip to the background pauses; coming back after a real trip resumes, while
// coming back from Control Center changes nothing. (Application-level notifications: they
// arrive with and without scenes.)
@MainActor
public final class AppLifecycle {
    public static let shared = AppLifecycle()

    public private(set) var isActive = false
    public private(set) var wasBackgrounded = false
    private var resign: [() -> Void] = []
    private var background: [() -> Void] = []
    private var active: [(_ afterBackground: Bool) -> Void] = []
    private var observers: [NSObjectProtocol] = []

    private init() {
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { AppLifecycle.shared.resigned() }
            },
            center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { AppLifecycle.shared.enteredBackground() }
            },
            center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { AppLifecycle.shared.activated() }
            },
        ]
    }

    // Leaving the screen at all: save, hand transfers to iOS (while still active: iOS defers
    // transfers started from the background).
    public func onResignActive(_ action: @escaping () -> Void) { resign.append(action) }
    // A real trip to the background: pause.
    public func onBackground(_ action: @escaping () -> Void) { background.append(action) }
    // Active again; `afterBackground` false for Control Center, Face ID and the like.
    public func onActive(_ action: @escaping (_ afterBackground: Bool) -> Void) { active.append(action) }

    private func resigned() {
        isActive = false
        let task = UIApplication.shared.beginBackgroundTask(withName: "Save on resign")
        resign.forEach { $0() }
        UIApplication.shared.endBackgroundTask(task)
    }

    private func enteredBackground() {
        wasBackgrounded = true
        let task = UIApplication.shared.beginBackgroundTask(withName: "Pause")
        background.forEach { $0() }
        UIApplication.shared.endBackgroundTask(task)
    }

    private func activated() {
        let afterBackground = wasBackgrounded
        wasBackgrounded = false
        isActive = true
        active.forEach { $0(afterBackground) }
    }
}
#endif
