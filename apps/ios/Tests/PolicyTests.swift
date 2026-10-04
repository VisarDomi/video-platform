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
                // Video Vault's page may also open XVideos (its login) beside its own site.
                check(hosts.count == (product["workers"] == nil ? 2 : 4) && hosts.contains(start.host!), "\(provider) start URL is on its site")
                if provider == "tango-live" {
                    check(allows("https://tango.me/stream/abc") && !allows("https://gateway.tango.me/"), "tango-live pages stay on tango.me")
                }
                for host in hosts {
                    for path in ["/", "/account", "/login/", "/video.abc/x", "/video/1/x/", "/my/videos/", "/account/uploads/new"] {
                        check(allows("https://\(host)\(path)"), "\(provider) allows \(host)\(path)")
                    }
                    for raw in ["http://\(host)/", "https://\(host):8443/", "https://user@\(host)/", "https://\(host)/a/../b"] {
                        check(!allows(raw), "\(provider) blocks \(raw)")
                    }
                }
                for (site, worker) in product["workers"] as? [String: [String: Any]] ?? [:] {
                    let page = URL(string: worker["url"] as! String)!, workerHosts = worker["hosts"] as! [String]
                    check(workerHosts.allSatisfy(hosts.contains) && !workerHosts.contains(start.host!), "\(provider) \(site) worker is another of its sites")
                    for path in ["/account/uploads", "/account/uploads/2", "/video.abc/slug", "/robots.txt?x=1"] {
                        check(AppPolicy.workerURL(path, page: page, hosts: workerHosts)?.host == page.host, "\(site) worker reads \(path)")
                    }
                    for path in ["account", "//evil.example/x", "https://evil.example/", "https://\(start.host!)/", "/a/../b", "/./a", "\\evil", ""] {
                        check(AppPolicy.workerURL(path, page: page, hosts: workerHosts) == nil, "\(site) worker refuses \(path)")
                    }
                }
                for raw in ["https://accounts.google.com/", "https://192.168.1.197:9999/videos/tango", "https://evil-\(hosts[0])/",
                            "https://\(hosts[0]).example.com/", "about:blank"] {
                    check(!allows(raw), "\(provider) blocks \(raw)")
                }
            }
        }
        let names = Set(registry.values.map { $0["name"] as! String }), ids = Set(registry.values.map { $0["bundleId"] as! String })
        check(names == ["Tango local", "FC2 local", "SC local", "Video Vault", "Tango"], "display names")
        check(ids == ["com.visar.TangoLocal.paid", "com.visar.FC2Local.paid", "com.visar.SCLocal.paid",
                      "com.visar.Ptrex.paid", "com.visar.Tango.paid"], "paid bundle IDs; Tango and Video Vault (formerly Ptrex) keep their original identities")
        if failures > 0 { print("\(failures) policy check(s) failed"); exit(1) }
        print("PASS: local apps allow only their provider's pages on the PC; online apps only their own site")
    }
}
