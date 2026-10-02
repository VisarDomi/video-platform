import Foundation

// Run on the Mac: xcrun swiftc -parse-as-library LocalVideos/Policy.swift Tests/PolicyTests.swift -o build/policy-tests
@main
struct PolicyTests {
    static func main() throws {
        let registry = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "providers.json"))) as! [String: [String: String]]
        var failures = 0
        func check(_ condition: Bool, _ label: String) {
            if !condition { failures += 1; print("FAIL:", label) }
        }
        for (provider, product) in registry.sorted(by: { $0.key < $1.key }) {
            let home = URL(string: product["url"]!)!
            check(home.absoluteString == "https://192.168.1.197:9999/videos/\(provider)", "\(provider) home is its Safari tab")
            let allowed = ["", "/", "/2026-01-20%20140639", "/clip?type=edited", "?scroll=1"]
            for suffix in allowed { check(LocalPolicy.allows(URL(string: home.absoluteString + suffix)!, home: home), "\(provider) allows \(suffix)") }
            let others = registry.keys.filter { $0 != provider }
            var blocked = ["https://192.168.1.197:9999/", "https://192.168.1.197:9999/\(provider)", "https://192.168.1.197:9999/api/videos",
                           "http://192.168.1.197:9999/videos/\(provider)", "https://192.168.1.197:7777/videos/\(provider)",
                           "https://192.168.1.198:9999/videos/\(provider)", "https://user@192.168.1.197:9999/videos/\(provider)",
                           "https://192.168.1.197:9999/videos/\(provider)x", "https://192.168.1.197:9999/videos/\(provider)/../fc2",
                           "https://example.com/videos/\(provider)", "about:blank"]
            blocked += others.map { "https://192.168.1.197:9999/videos/\($0)" }
            for raw in blocked { check(!LocalPolicy.allows(URL(string: raw)!, home: home), "\(provider) blocks \(raw)") }
        }
        let names = Set(registry.values.map { $0["name"]! }), ids = Set(registry.values.map { $0["bundleId"]! })
        check(names == ["Tango local", "FC2 local", "SC local"], "display names")
        check(ids.count == 3 && !ids.contains("com.visar.Tango.paid") && ids.allSatisfy { $0.hasSuffix(".paid") }, "distinct paid bundle IDs")
        if failures > 0 { print("\(failures) policy check(s) failed"); exit(1) }
        print("PASS: each app allows only its own provider's pages on the PC")
    }
}
