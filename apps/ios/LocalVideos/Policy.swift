import Foundation

// Each app is one Safari tab: its home page and that provider's videos on the PC.
enum LocalPolicy {
    static func allows(_ url: URL, home: URL) -> Bool {
        guard url.scheme == home.scheme, url.host == home.host, url.port == home.port,
              url.user == nil, url.password == nil,
              !url.pathComponents.contains(where: { $0 == ".." || $0 == "." }) else { return false }
        return url.path == home.path || url.path.hasPrefix(home.path + "/")
    }
}
