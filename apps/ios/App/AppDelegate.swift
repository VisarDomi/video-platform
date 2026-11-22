import UIKit
import KitLifecycle
import KitTestHooks
import KitCore

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

// Every app is a native list (VideoList.swift) with the native viewer over it: the PC's
// recordings (local apps, Info.plist LocalProvider) or a site's own list (NativeList).
@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var list: VideoListController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        window.backgroundColor = .black
        DebugState.shared.register("app") {
            ["bundle": Bundle.main.bundleIdentifier ?? "", "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
             "source": Bundle.main.object(forInfoDictionaryKey: "VideoSourceRevision") as? String ?? ""]
        }
        #if targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-navigation-check") {
            window.rootViewController = ListNavigationChecks()
            window.makeKeyAndVisible()
            self.window = window
            TestHooks.shared.start()
            return
        }
        if ProcessInfo.processInfo.arguments.contains("-zoom-check") {
            window.rootViewController = ZoomChecks()
            window.makeKeyAndVisible()
            self.window = window
            TestHooks.shared.start()
            return
        }
        // A plug-in's own checks (its plugin.json "checks").
        if let check = Plugins.check(ProcessInfo.processInfo.arguments) {
            window.rootViewController = check
            window.makeKeyAndVisible()
            self.window = window
            TestHooks.shared.start()
            return
        }
        #endif
        let info = Bundle.main.infoDictionary ?? [:]
        let list: VideoListController
        var resumed: (Bool) -> Void = { _ in }
        var paused: () -> Void = {}
        if let provider = info["LocalProvider"] as? String {
            let server = (info["StartURL"] as? String).flatMap(URL.init(string:)) ?? PCReach.home
            let kind = LocalMediaKind(rawValue: info["LocalMediaKind"] as? String ?? "hls") ?? .hls
            let local = LocalListController(provider: provider, server: server, mediaKind: kind)
            (resumed, paused) = ({ [weak local] in local?.resumed(afterBackground: $0) }, { [weak local] in local?.paused() })
            list = local
            #if targetEnvironment(simulator)
            FluidityChecks.shared.install(local)
            #endif
        } else if let name = info["NativeList"] as? String, let native = NativeLists.make(name) {
            (list, resumed, paused) = (native.list, native.resumed, native.paused)
        } else {
            fatalError("Info.plist names neither a LocalProvider nor a known NativeList")
        }
        self.list = list
        AppLifecycle.shared.onActive(resumed)
        AppLifecycle.shared.onBackground(paused)
        #if targetEnvironment(simulator)
        TestHooks.shared.back = { [weak list] in list?.viewer?.slideAway() }
        TestHooks.shared.forward = { [weak list] in list?.goForward() }
        TestHooks.shared.start()
        #endif
        window.rootViewController = list
        window.makeKeyAndVisible()
        self.window = window
    }
}
