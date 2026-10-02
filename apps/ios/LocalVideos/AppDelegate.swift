import UIKit

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var browser: WebController!
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        browser = WebController(home: URL(string: Bundle.main.object(forInfoDictionaryKey: "LocalVideosURL") as! String)!)
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.overrideUserInterfaceStyle = .dark
        window?.rootViewController = browser
        window?.makeKeyAndVisible()
        return true
    }
    func applicationWillResignActive(_ application: UIApplication) { browser.saveSession() }
    func applicationDidEnterBackground(_ application: UIApplication) { browser.saveSession() }
}
