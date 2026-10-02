import Foundation
import WebKit

// Tango signs in with Google, which an app's web view cannot do. The Tango Login Safari
// helper imports Safari's session into the shared Keychain; once the user confirms that
// Safari's copy was deleted, the app moves those cookies into its web view, where the
// website refreshes them itself (and SiteCookies keeps them). The page also gets the
// account and session IDs that the Tango website would have stored for itself.
@MainActor
enum TangoSession {
    enum State { case ready(String), pending, required }

    static func prepare(store: WKHTTPCookieStore, done: @escaping @MainActor (State) -> Void) {
        let inbox: TangoLoginInbox?
        do { inbox = try LoginStore.load().map(TangoLoginInbox.init) } catch { inbox = nil }
        if let inbox, !inbox.confirmed { return done(.pending) }
        let imported = inbox?.cookies ?? []
        var remaining = imported.count
        let finish = {
            if inbox != nil { try? LoginStore.delete() }
            store.getAllCookies { cookies in
                guard let token = cookies.first(where: { $0.name == "Tango-RT" && !$0.value.isEmpty })?.value,
                      let ids = sessionIDs(token) else { return done(.required) }
                done(.ready(script(ids)))
            }
        }
        if imported.isEmpty { return finish() }
        for cookie in imported {
            store.setCookie(cookie) {
                remaining -= 1
                if remaining == 0 { finish() }
            }
        }
    }

    // Marks a pending import as confirmed after the user deleted Tango's Safari data.
    static func confirm() throws {
        guard var login = try LoginStore.load(), login.handoffComplete != true else { return }
        login.handoffComplete = true
        try LoginStore.save(login)
    }

    // The RT's payload names the account and session the refresh call needs.
    private static func sessionIDs(_ token: String) -> (account: String, session: String)? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let account = claims["accountId"] as? String, let session = claims["sessionId"] as? String else { return nil }
        return (account, session)
    }

    private static func script(_ ids: (account: String, session: String)) -> String {
        let encode = { (value: String) in String(data: try! JSONSerialization.data(withJSONObject: [value]), encoding: .utf8)!.dropFirst().dropLast() }
        return "localStorage.setItem('latest_account_id', \(encode(ids.account))); sessionStorage.setItem('username', \(encode(ids.session)));"
    }
}

private struct TangoLoginInbox {
    let confirmed: Bool
    let cookies: [HTTPCookie]
    init(_ login: TangoLogin) {
        confirmed = login.handoffComplete == true
        cookies = login.cookies.compactMap { item in
            HTTPCookie(properties: [.name: item.name, .value: item.value, .domain: item.domain, .path: item.path,
                                    .secure: "TRUE", .expires: Date(timeIntervalSince1970: item.expirationDate),
                                    HTTPCookiePropertyKey("HttpOnly"): "TRUE"])
        }
    }
}
