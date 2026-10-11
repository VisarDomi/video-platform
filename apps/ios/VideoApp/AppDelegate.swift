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

@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var browser: WebController?
    private var list: LocalListController?
    private var vault: VaultListController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let start = URL(string: Bundle.main.object(forInfoDictionaryKey: "StartURL") as! String)!
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        window.backgroundColor = .black
        // Local apps are native lists on the PC's API, Video Vault on its sites' pages; Tango still shows its site.
        if let provider = Bundle.main.object(forInfoDictionaryKey: "LocalProvider") as? String,
           let server = URL(string: "/", relativeTo: start)?.absoluteURL {
            let list = LocalListController(provider: provider, server: server)
            self.list = list
            window.rootViewController = list
            AppLifecycle.shared.onActive { [weak list] afterBackground in list?.resumed(afterBackground: afterBackground) }
            AppLifecycle.shared.onBackground { [weak list] in list?.paused() }
            #if targetEnvironment(simulator)
            TestHooks.shared.start()
            #endif
        } else if Bundle.main.object(forInfoDictionaryKey: "VaultApp") as? Bool == true {
            let vault = VaultListController()
            self.vault = vault
            window.rootViewController = vault
            AppLifecycle.shared.onActive { [weak vault] afterBackground in vault?.resumed(afterBackground: afterBackground) }
            AppLifecycle.shared.onBackground { [weak vault] in vault?.paused() }
            #if targetEnvironment(simulator)
            TestHooks.shared.start()
            #endif
        } else {
            let browser = WebController(start: start, hosts: Bundle.main.object(forInfoDictionaryKey: "SiteHosts") as? [String] ?? [])
            self.browser = browser
            window.rootViewController = browser
        }
        window.makeKeyAndVisible()
        self.window = window
    }

    func sceneDidBecomeActive(_ scene: UIScene) { browser?.resume() }
    func sceneWillResignActive(_ scene: UIScene) { browser?.saveSession() }
    // iOS evicts only backgrounded apps; give the login cookie time to be saved first.
    func sceneDidEnterBackground(_ scene: UIScene) {
        guard let browser else { return }
        let task = UIApplication.shared.beginBackgroundTask(withName: "Save session")
        browser.saveSession { UIApplication.shared.endBackgroundTask(task) }
    }
}
