import Foundation
import os
import WebKit

// Keeps an online app signed in across relaunches.
// - WebKit writes cookies to disk only when the app is suspended, so a login followed by
//   a kill without a background transition (such as a swipe from the app switcher) was
//   lost. The app keeps its own copy of the login cookies, in its container beside
//   WebKit's cookie file, and restores missing ones before the first page loads. When
//   the site removes them (logout, revocation) the copy is cleared too.
// - XVideos keeps its login in a session-only cookie beside a persistent session cookie.
//   That login cookie gets the persistent cookie's lifetime, the same rule as the Xvid
//   Safari extension. Server expiry, revocation and logout still apply.
@MainActor
final class SiteCookies: NSObject, WKHTTPCookieStoreObserver {
    struct Durable { let name: String; let lifetimeFrom: String }
    private let store: WKHTTPCookieStore
    private let hosts: [String]
    private let names: [String]
    private let durable: Durable?
    private let backupURL: URL
    private var restored = false
    private var lastBackup: Data?

    init(store: WKHTTPCookieStore, hosts: [String], keep keepNames: [String], durable: Durable?, backupURL: URL) {
        self.store = store
        self.hosts = hosts
        self.names = keepNames + (durable.map { [$0.name] } ?? [])
        self.durable = durable
        self.backupURL = backupURL
        super.init()
        store.add(self)
    }

    nonisolated func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        Task { @MainActor in self.keep() }
    }

    // Before the first page: put back saved login cookies that WebKit lost.
    func restore(_ done: @escaping @MainActor () -> Void) {
        let saved = (try? Data(contentsOf: backupURL))
            .flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [[String: Any]] } ?? []
        let backup = saved.compactMap { item in
            HTTPCookie(properties: Dictionary(uniqueKeysWithValues: item.map { (HTTPCookiePropertyKey($0.key), $0.value) }))
        }.filter { ($0.expiresDate ?? .distantPast) > Date() }
        store.getAllCookies { [self] cookies in
            let missing = backup.filter { saved in !cookies.contains { $0.name == saved.name && $0.domain == saved.domain && $0.path == saved.path } }
            if !missing.isEmpty { log("restored \(missing.count) login cookie(s) WebKit had not saved") }
            setAll(missing) { [self] in
                restored = true
                done()
            }
        }
    }

    // `done` runs once the cookie store has the result, so a backgrounding app can wait for it.
    func keep(_ done: @escaping @MainActor () -> Void = {}) {
        guard restored else { return done() }
        store.getAllCookies { [self] cookies in
            let site = cookies.filter(onSite)
            let extended = extendedLogin(site)
            var login = site.filter { names.contains($0.name) && !$0.isSessionOnly }
            if let extended {
                login.removeAll { $0.name == extended.name && $0.domain == extended.domain && $0.path == extended.path }
                login.append(extended)
            }
            backUp(login)
            setAll(extended.map { [$0] } ?? [], done)
        }
    }

    // A site's cookies include its subdomains (Tango's login lives on gateway.tango.me).
    private func onSite(_ cookie: HTTPCookie) -> Bool {
        let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return hosts.contains { domain == $0 || domain.hasSuffix("." + $0) }
    }

    private func setAll(_ cookies: [HTTPCookie], _ done: @escaping @MainActor () -> Void) {
        guard !cookies.isEmpty else { return done() }
        var remaining = cookies.count
        for cookie in cookies {
            store.setCookie(cookie) {
                remaining -= 1
                if remaining == 0 { done() }
            }
        }
    }

    private func backUp(_ cookies: [HTTPCookie]) {
        let items = cookies.compactMap { $0.properties }.map { Dictionary(uniqueKeysWithValues: $0.map { ($0.key.rawValue, $0.value) }) }
        guard let data = try? PropertyListSerialization.data(fromPropertyList: items, format: .binary, options: 0), data != lastBackup else { return }
        do {
            try FileManager.default.createDirectory(at: backupURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: backupURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            lastBackup = data
        } catch { log("could not save login cookies: \(error)") }
    }

    private func extendedLogin(_ site: [HTTPCookie]) -> HTTPCookie? {
        guard let durable, let auth = site.first(where: { $0.name == durable.name }), auth.isSessionOnly else { return nil }
        guard let session = site.first(where: { $0.name == durable.lifetimeFrom }), let expires = session.expiresDate, expires > Date(),
              auth.isHTTPOnly, auth.isSecure, auth.domain == session.domain, auth.path == session.path,
              var properties = auth.properties else { log("login cookie does not match its session cookie"); return nil }
        // XVideos sends a version 1 cookie, for which Foundation ignores Expires.
        properties[.version] = "0"
        properties[.expires] = expires
        properties[.maximumAge] = String(Int(expires.timeIntervalSinceNow))
        properties.removeValue(forKey: .discard)
        guard let cookie = HTTPCookie(properties: properties), !cookie.isSessionOnly else { log("could not build durable cookie"); return nil }
        return cookie
    }

    private func log(_ message: String) { logger.notice("SiteCookies: \(message, privacy: .public)") }
    private let logger = Logger(subsystem: "com.visar.VideoApp", category: "SiteCookies")
}
