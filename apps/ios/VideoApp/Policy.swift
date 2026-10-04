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

    // Video Vault's page may have a site worker read only that site's own pages: an absolute
    // path (no scheme, host or credentials of its own), resolved against the worker's page.
    static func workerURL(_ path: String, page: URL, hosts: [String]) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"),
              let url = URL(string: path, relativeTo: page)?.absoluteURL, allows(url, start: page, hosts: hosts) else { return nil }
        return url
    }
}
