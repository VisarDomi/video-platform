import Foundation
import KitCore

// The app's cookies, owned by the app: one jar per app, saved in its data folder, written
// whenever it changes. Sessions never store or send cookies by themselves (no WebKit store,
// no HTTPCookieStorage), so there is exactly one place a login lives and one owner of every
// refresh. Session cookies are kept like persistent ones: the app is the browser that never
// closes. Media requests get the same cookies (AVURLAssetHTTPCookiesKey).
public final class CookieJar: @unchecked Sendable {
    struct Stored: Codable, Equatable {
        var name: String
        var value: String
        var domain: String
        var path: String
        var expires: Date?
        var secure: Bool
        var httpOnly: Bool
    }

    private let lock = NSLock()
    private var cookies: [Stored]
    private let writer: BackgroundWriter?

    // `file` nil keeps cookies in memory only (tests).
    public init(file: URL?) {
        writer = file.map { BackgroundWriter(url: $0, label: "kit-cookies") }
        let loaded = file.flatMap { try? DurableFile.readJSON([Stored].self, from: $0) } ?? []
        cookies = loaded.filter { !Self.expired($0) }
    }

    public var all: [HTTPCookie] { lock.withLock { cookies.compactMap(Self.cookie) } }

    public func cookies(for url: URL) -> [HTTPCookie] {
        guard let host = url.host?.lowercased() else { return [] }
        let path = url.path.isEmpty ? "/" : url.path
        let secure = url.scheme == "https"
        return lock.withLock {
            cookies.filter { stored in
                !Self.expired(stored) && Self.domainMatches(host, stored.domain) && Self.pathMatches(path, stored.path)
                    && (!stored.secure || secure)
            }
            // RFC 6265: longer paths first.
            .sorted { $0.path.count > $1.path.count }
            .compactMap(Self.cookie)
        }
    }

    public func header(for url: URL) -> String? {
        let list = cookies(for: url)
        return list.isEmpty ? nil : list.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }

    public func value(_ name: String, for url: URL) -> String? { cookies(for: url).first { $0.name == name }?.value }

    public func store(from response: HTTPURLResponse) {
        guard let url = response.url, let fields = response.allHeaderFields as? [String: String] else { return }
        set(HTTPCookie.cookies(withResponseHeaderFields: fields, for: url))
    }

    public func set(_ new: [HTTPCookie]) {
        guard !new.isEmpty else { return }
        let changed = lock.withLock { () -> Bool in
            let before = cookies
            for cookie in new {
                let stored = Self.stored(cookie)
                cookies.removeAll { $0.name == stored.name && $0.domain == stored.domain && $0.path == stored.path }
                if !Self.expired(stored) { cookies.append(stored) }
            }
            return cookies != before
        }
        if changed { save() }
    }

    public func remove(where shouldRemove: (HTTPCookie) -> Bool) {
        let changed = lock.withLock { () -> Bool in
            let before = cookies.count
            cookies.removeAll { stored in Self.cookie(stored).map(shouldRemove) ?? true }
            return cookies.count != before
        }
        if changed { save() }
    }

    public func flush() { writer?.flush() }

    private func save() {
        let snapshot = lock.withLock { cookies }
        writer?.save(json: snapshot)
    }

    private static func expired(_ stored: Stored) -> Bool { stored.expires.map { $0 <= Date() } ?? false }

    static func domainMatches(_ host: String, _ domain: String) -> Bool {
        let domain = domain.lowercased()
        if domain.hasPrefix(".") { let bare = String(domain.dropFirst()); return host == bare || host.hasSuffix(domain) }
        return host == domain
    }

    static func pathMatches(_ path: String, _ cookiePath: String) -> Bool {
        if path == cookiePath { return true }
        guard path.hasPrefix(cookiePath) else { return false }
        return cookiePath.hasSuffix("/") || path.dropFirst(cookiePath.count).hasPrefix("/")
    }

    private static func stored(_ cookie: HTTPCookie) -> Stored {
        Stored(name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path.isEmpty ? "/" : cookie.path,
               expires: cookie.expiresDate, secure: cookie.isSecure, httpOnly: cookie.isHTTPOnly)
    }

    private static func cookie(_ stored: Stored) -> HTTPCookie? {
        var properties: [HTTPCookiePropertyKey: Any] = [.name: stored.name, .value: stored.value, .domain: stored.domain, .path: stored.path]
        if let expires = stored.expires { properties[.expires] = expires }
        if stored.secure { properties[.secure] = "TRUE" }
        if stored.httpOnly { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
        return HTTPCookie(properties: properties)
    }
}
