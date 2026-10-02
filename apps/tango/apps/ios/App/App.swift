import UIKit

@main @MainActor final class App: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var browser: WebController!
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        browser = WebController()
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.overrideUserInterfaceStyle = .dark
        window?.rootViewController = browser
        window?.makeKeyAndVisible()
        return true
    }
    func applicationWillResignActive(_ application: UIApplication) { browser.capture() }
    func applicationDidEnterBackground(_ application: UIApplication) { browser.pause() }
    func applicationDidBecomeActive(_ application: UIApplication) { browser.resume() }
}
