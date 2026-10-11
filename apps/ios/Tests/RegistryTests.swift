import Foundation

// providers.json: the five apps' names, bundle IDs (never changed: a new ID loses the app's data
// and logins) and how each lists its videos.
@main
struct RegistryTests {
    static func main() throws {
        let registry = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "providers.json"))) as! [String: [String: Any]]
        var failures = 0
        func check(_ condition: Bool, _ label: String) { if !condition { failures += 1; print("FAIL:", label) } }
        for provider in ["tango", "fc2", "sc"] {
            let product = registry[provider] ?? [:]
            check(product["hosts"] == nil && product["native"] == nil && product["url"] as? String == "https://192.168.1.197:9999/videos/\(provider)", "\(provider) lists the PC's recordings")
        }
        check(registry["vault"]?["native"] as? String == "vault" && (registry["vault"]?["hosts"] as? [String])?.count == 4, "Video Vault lists both sites natively")
        check(registry["tango-live"]?["native"] as? String == "tango" && registry["tango-live"]?["tangoLogin"] as? Bool == true
              && registry["tango-live"]?["extensions"] as? [String] == ["Login", "FC2Live", "SCLive"], "Tango lists natively and keeps its Safari extensions")
        let names = Set(registry.values.map { $0["name"] as! String }), ids = Set(registry.values.map { $0["bundleId"] as! String })
        check(names == ["Tango local", "FC2 local", "SC local", "Video Vault", "Tango"], "display names")
        check(ids == ["com.visar.TangoLocal.paid", "com.visar.FC2Local.paid", "com.visar.SCLocal.paid",
                      "com.visar.Ptrex.paid", "com.visar.Tango.paid"], "paid bundle IDs; Tango and Video Vault (formerly Ptrex) keep their original identities")
        if failures > 0 { print("\(failures) registry check(s) failed"); exit(1) }
        print("PASS: registry (names, bundle IDs, list kinds)")
    }
}
