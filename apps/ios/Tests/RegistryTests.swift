import Foundation

// providers.json's bundle IDs are permanent: iOS keys an app's data and logins to its bundle ID,
// so a changed ID installs a new, empty app. Add new apps; never change these.
@main
struct RegistryTests {
    static func main() throws {
        let registry = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "providers.json"))) as! [String: [String: Any]]
        let permanent = ["tango": "com.visar.TangoLocal.paid", "fc2": "com.visar.FC2Local.paid", "sc": "com.visar.SCLocal.paid",
                         "bunkr": "com.visar.BunkrLocal.paid", "vault": "com.visar.Ptrex.paid", "tango-live": "com.visar.Tango.paid"]
        for (provider, id) in permanent where registry[provider]?["bundleId"] as? String != id {
            print("FAIL: \(provider) must keep bundle ID \(id)"); exit(1)
        }
        print("PASS: registry keeps every existing app's bundle ID")
    }
}
