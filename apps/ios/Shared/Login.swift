import Foundation
import Security

struct LoginCookie: Codable {
    let name: String
    let value: String
    let domain: String
    let path: String
    let expirationDate: Double
}

struct TangoLogin: Codable {
    var cookies: [LoginCookie]
    var handoffComplete: Bool?

    var session: [String: String]? {
        guard let token = cookies.first(where: { $0.name == "Tango-RT" })?.value else { return nil }
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let account = claims["accountId"] as? String,
              let session = claims["sessionId"] as? String else { return nil }
        return ["accountId": account, "sessionId": session]
    }
}

enum LoginStore {
    static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "TangoLogin",
         kSecAttrAccount as String: "session",
         kSecAttrAccessGroup as String: Bundle.main.object(forInfoDictionaryKey: "LoginKeychainGroup") as! String]
    }

    static func load() throws -> TangoLogin? {
        var q = query
        q[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw failure("Keychain read", status) }
        return try JSONDecoder().decode(TangoLogin.self, from: data)
    }

    static func save(_ login: TangoLogin) throws {
        guard login.session != nil, login.cookies.contains(where: { $0.name == "Tango-RT" }) else {
            throw failure("Incomplete Tango login", -1)
        }
        let data = try JSONEncoder().encode(login)
        let attributes = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly] as [String: Any]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw failure("Keychain save", status) }
    }

    static func failure(_ operation: String, _ code: Int32) -> NSError {
        NSError(domain: "TangoLogin", code: Int(code), userInfo: [NSLocalizedDescriptionKey: "\(operation) (\(code))"])
    }
}
