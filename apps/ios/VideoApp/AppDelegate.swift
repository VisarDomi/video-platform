import UIKit
import KitLifecycle
import KitTestHooks

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
// recordings (local apps), Video Vault's two sites, or Tango's live streams.
@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var list: VideoListController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        window.backgroundColor = .black
        let info = Bundle.main.infoDictionary ?? [:]
        let list: VideoListController
        var resumed: (Bool) -> Void = { _ in }
        var paused: () -> Void = {}
        if let provider = info["LocalProvider"] as? String {
            let local = LocalListController(provider: provider, server: URL(string: "https://192.168.1.197:9999/")!)
            (resumed, paused) = ({ [weak local] in local?.resumed(afterBackground: $0) }, { [weak local] in local?.paused() })
            list = local
        } else if info["NativeList"] as? String == "tango" {
            let tango = TangoListController()
            (resumed, paused) = ({ [weak tango] in tango?.resumed(afterBackground: $0) }, { [weak tango] in tango?.paused() })
            list = tango
        } else {
            let vault = VaultListController()
            (resumed, paused) = ({ [weak vault] in vault?.resumed(afterBackground: $0) }, { [weak vault] in vault?.paused() })
            list = vault
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
