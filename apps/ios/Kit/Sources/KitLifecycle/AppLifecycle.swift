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

    private var lifecycle: LifecycleState
    public var phase: LifecycleState.Phase { lifecycle.phase }
    public var isActive: Bool { lifecycle.phase == .active }
    public var wasBackgrounded: Bool { lifecycle.phase == .background }
    private var resign: [() -> Void] = []
    private var resignAsync: [@MainActor @Sendable () async -> Void] = []
    private var background: [() -> Void] = []
    private var active: [(_ afterBackground: Bool) -> Void] = []
    private var observers: [NSObjectProtocol] = []

    private init() {
        switch UIApplication.shared.applicationState {
        case .active: lifecycle = LifecycleState(.active)
        case .background: lifecycle = LifecycleState(.background)
        default: lifecycle = LifecycleState()
        }
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
    public func onResignActiveAsync(_ action: @escaping @MainActor @Sendable () async -> Void) { resignAsync.append(action) }
    // A real trip to the background: pause.
    public func onBackground(_ action: @escaping () -> Void) { background.append(action) }
    // Active again; `afterBackground` false for Control Center, Face ID and the like.
    public func onActive(_ action: @escaping (_ afterBackground: Bool) -> Void) { active.append(action) }

    private func resigned() { apply(lifecycle.receive(.resign)) }
    private func enteredBackground() { apply(lifecycle.receive(.background)) }
    private func activated() { apply(lifecycle.receive(.activate)) }

    private func runAsyncSave() {
        let lease = LifecycleSaveLease()
        let actions = resignAsync, activation = lifecycle.activation
        Task { @MainActor in
            defer { lease.end() }
            for action in actions {
                guard !isActive, lifecycle.activation == activation else { return }
                await action()
            }
        }
    }

    private func apply(_ effects: [LifecycleState.Effect]) {
        guard !effects.isEmpty else { return }
        let task = UIApplication.shared.beginBackgroundTask(withName: "Lifecycle transition")
        for effect in effects {
            switch effect {
            case .save:
                resign.forEach { $0() }
                if !resignAsync.isEmpty { runAsyncSave() }
            case .pause: background.forEach { $0() }
            case .resume(let afterBackground): active.forEach { $0(afterBackground) }
            }
        }
        UIApplication.shared.endBackgroundTask(task)
    }
}
@MainActor
private final class LifecycleSaveLease {
    private var identifier = UIBackgroundTaskIdentifier.invalid
    init() {
        identifier = UIApplication.shared.beginBackgroundTask(withName: "Save and hand off") { [weak self] in
            Task { @MainActor in self?.end() }
        }
    }
    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier); identifier = .invalid
    }
}

#endif
