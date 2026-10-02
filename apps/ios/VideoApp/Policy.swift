import Foundation

enum AppPolicy {
    // Local apps are one Safari tab: the start URL and its subpaths on the PC.
    // Online apps cover their site's hosts over HTTPS, like their Safari extension.
    static func allows(_ url: URL, start: URL, hosts: [String]) -> Bool {
        guard url.user == nil, url.password == nil,
              !url.pathComponents.contains(where: { $0 == ".." || $0 == "." }) else { return false }
        if !hosts.isEmpty { return url.scheme == "https" && url.port == nil && hosts.contains(url.host ?? "") }
        guard url.scheme == start.scheme, url.host == start.host, url.port == start.port else { return false }
        return url.path == start.path || url.path.hasPrefix(start.path + "/")
    }
}
