import UIKit

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var browser: WebController!
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        browser = WebController(start: URL(string: Bundle.main.object(forInfoDictionaryKey: "StartURL") as! String)!,
                                hosts: Bundle.main.object(forInfoDictionaryKey: "SiteHosts") as? [String] ?? [])
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.overrideUserInterfaceStyle = .dark
        window?.rootViewController = browser
        window?.makeKeyAndVisible()
        return true
    }
    func applicationDidBecomeActive(_ application: UIApplication) { browser.resume() }
    func applicationWillResignActive(_ application: UIApplication) { browser.saveSession() }
    // iOS evicts only backgrounded apps; give the login cookie time to be saved first.
    func applicationDidEnterBackground(_ application: UIApplication) {
        let task = application.beginBackgroundTask(withName: "Save session")
        browser.saveSession { application.endBackgroundTask(task) }
    }
}
