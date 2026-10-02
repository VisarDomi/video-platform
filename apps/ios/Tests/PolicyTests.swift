import Foundation

// Run on the Mac: xcrun swiftc -parse-as-library VideoApp/Policy.swift Tests/PolicyTests.swift -o build/policy-tests
@main
struct PolicyTests {
    static func main() throws {
        let registry = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: "providers.json"))) as! [String: [String: Any]]
        var failures = 0
        func check(_ condition: Bool, _ label: String) {
            if !condition { failures += 1; print("FAIL:", label) }
        }
        let local = ["tango", "fc2", "sc"]
        for (provider, product) in registry.sorted(by: { $0.key < $1.key }) {
            let start = URL(string: product["url"] as! String)!
            let hosts = product["hosts"] as? [String] ?? []
            func allows(_ raw: String) -> Bool { AppPolicy.allows(URL(string: raw)!, start: start, hosts: hosts) }
            if local.contains(provider) {
                check(hosts.isEmpty && start.absoluteString == "https://192.168.1.197:9999/videos/\(provider)", "\(provider) is its Safari tab")
                for suffix in ["", "/", "/2026-01-20%20140639", "/clip?type=edited", "?scroll=1"] {
                    check(allows(start.absoluteString + suffix), "\(provider) allows \(suffix)")
                }
                var blocked = ["https://192.168.1.197:9999/", "https://192.168.1.197:9999/\(provider)", "https://192.168.1.197:9999/api/videos",
                               "http://192.168.1.197:9999/videos/\(provider)", "https://192.168.1.197:7777/videos/\(provider)",
                               "https://192.168.1.198:9999/videos/\(provider)", "https://user@192.168.1.197:9999/videos/\(provider)",
                               "https://192.168.1.197:9999/videos/\(provider)x", "https://192.168.1.197:9999/videos/\(provider)/../fc2",
                               "https://example.com/videos/\(provider)", "about:blank"]
                blocked += local.filter { $0 != provider }.map { "https://192.168.1.197:9999/videos/\($0)" }
                for raw in blocked { check(!allows(raw), "\(provider) blocks \(raw)") }
            } else {
                check(hosts.count == 2 && hosts.contains(start.host!), "\(provider) start URL is on its site")
                for host in hosts {
                    for path in ["/", "/account", "/login/", "/video.abc/x", "/video/1/x/", "/my/videos/", "/account/uploads/new"] {
                        check(allows("https://\(host)\(path)"), "\(provider) allows \(host)\(path)")
                    }
                    for raw in ["http://\(host)/", "https://\(host):8443/", "https://user@\(host)/", "https://\(host)/a/../b"] {
                        check(!allows(raw), "\(provider) blocks \(raw)")
                    }
                }
                for raw in ["https://accounts.google.com/", "https://192.168.1.197:9999/videos/tango", "https://evil-\(hosts[0])/",
                            "https://\(hosts[0]).example.com/", "about:blank"] {
                    check(!allows(raw), "\(provider) blocks \(raw)")
                }
            }
        }
        let names = Set(registry.values.map { $0["name"] as! String }), ids = Set(registry.values.map { $0["bundleId"] as! String })
        check(names == ["Tango local", "FC2 local", "SC local", "Xvid", "Ptrex"], "display names")
        check(ids.count == 5 && ids.isDisjoint(with: ["com.visar.Tango.paid", "com.visar.Tango.paid.Xvid", "com.visar.Tango.paid.Ptrex"])
              && ids.allSatisfy { $0.hasSuffix(".paid") }, "distinct paid bundle IDs, separate from Tango and its extensions")
        if failures > 0 { print("\(failures) policy check(s) failed"); exit(1) }
        print("PASS: local apps allow only their provider's pages on the PC; online apps only their own site")
    }
}
