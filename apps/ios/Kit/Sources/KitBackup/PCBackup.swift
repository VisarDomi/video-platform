import Foundation
import KitCore
import KitNet

// The apps' PC backups (the servers' /api/reader-backups/<app>/<provider>/<id>, each app
// repository's server/backups.mjs): first use offers "back up this phone" or "restore from
// the PC"; afterwards every visit backs up silently. An unreachable PC (no network, refused,
// timed out, 5xx, a lost answer) is silent: calls return nil. A restored phone gets a new
// identity; the original backup stays. The identity (`backup-identity.json`) records the
// last acknowledged revision; a lost acknowledgement retries with the same identity.
public struct BackupIdentity: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var revision: String?
    public init(id: String, label: String, revision: String?) {
        self.id = id
        self.label = label
        self.revision = revision
    }
}

public struct BackupChoice: @unchecked Sendable {
    public let selection: String
    public let label: String
    public let stats: String
    public let data: Any
}

public enum BackupError: LocalizedError {
    case http(Int, conflict: Bool)
    case invalid(String)
    public var errorDescription: String? {
        switch self {
        case .http(let status, let conflict): "PC backup HTTP \(status)" + (conflict ? ": revisit home to choose Backup or Restore" : "")
        case .invalid(let message): message
        }
    }
}

@MainActor
public final class PCBackup {
    public let scope: String
    private let base: URL
    private let key: String
    private let http: HTTPClient
    private let identityFile: URL
    private let capture: () -> [String: Any]
    private let restore: (Any) throws -> Void
    private let stats: (Any) throws -> String

    // `scope`: "<app>:<provider>" (e.g. "gallery-reader:hitomi").
    public init(scope: String, base: URL, key: String, trust: LocalTrust?, directory: URL,
                capture: @escaping () -> [String: Any], restore: @escaping (Any) throws -> Void, stats: @escaping (Any) throws -> String) {
        self.scope = scope
        self.base = base
        self.key = key
        http = HTTPClient(.init(trust: trust, connectionsPerHost: 2, requestTimeout: 8, resourceTimeout: 8))
        identityFile = directory.appendingPathComponent("backup-identity.json")
        self.capture = capture
        self.restore = restore
        self.stats = stats
    }

    public var identity: BackupIdentity? {
        get { try? DurableFile.readJSON(BackupIdentity.self, from: identityFile) }
        set {
            if let newValue { try? DurableFile.writeJSON(newValue, to: identityFile) }
            else { try? FileManager.default.removeItem(at: identityFile) }
        }
    }

    public var enrolled: Bool { identity?.revision != nil }

    // The PC's backups for this app, each current and previous snapshot a choice (validated
    // before it is offered); nil when the PC is unavailable.
    public func list() async throws -> [BackupChoice]? {
        guard let text = try await request("GET") else { return nil }
        guard let backups = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [[String: Any]] else { throw BackupError.invalid("Invalid backup listing") }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var choices: [BackupChoice] = []
        for backup in backups {
            guard let id = backup["id"] as? String, let label = backup["label"] as? String else { continue }
            for generation in ["current", "previous"] {
                guard let snapshot = backup[generation] as? [String: Any], let data = snapshot["data"] else { continue }
                let saved = (snapshot["savedAt"] as? String).flatMap { iso.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) }
                choices.append(BackupChoice(selection: id + ":" + generation,
                                            label: [label, String(id.prefix(8)), generation, saved.map(formatter.string) ?? ""].joined(separator: " · "),
                                            stats: try stats(data), data: data))
            }
        }
        return choices
    }

    // The first-use choice: restore (when given) and start a new identity under `label`.
    public func choose(label: String, restoring choice: BackupChoice?) throws {
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { throw BackupError.invalid("Backup name required") }
        if let choice { try restore(choice.data) }
        identity = BackupIdentity(id: UUID().uuidString.lowercased(), label: String(label.prefix(80)), revision: nil)
    }

    // Uploads the current data; nil when the PC is unavailable.
    @discardableResult
    public func save() async throws -> (label: String, stats: String)? {
        guard let current = identity else { throw BackupError.invalid("Choose Backup or Restore first") }
        let data = capture()
        let summary = try stats(data)
        var body: [String: Any] = ["label": current.label, "data": data]
        body["baseRevision"] = current.revision ?? NSNull()
        guard let text = try await request("PUT", body: try JSONSerialization.data(withJSONObject: body), id: current.id) else { return nil }
        guard let saved = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any], saved["id"] as? String == current.id,
              let revision = (saved["current"] as? [String: Any])?["revision"] as? String else { throw BackupError.invalid("Unexpected backup acknowledgement") }
        var acknowledged = current
        acknowledged.revision = revision
        identity = acknowledged
        return (current.label, summary)
    }

    private func request(_ method: String, body: Data? = nil, id: String? = nil) async throws -> String? {
        let path = "api/reader-backups/" + scope.replacingOccurrences(of: ":", with: "/") + (id.map { "/" + $0 } ?? "")
        let request = HTTPRequest(base.appendingPathComponent(path), method: method,
                                  headers: ["Content-Type": "application/json", "X-Reader-Backup-Key": key], body: body,
                                  retry: .never, accept: Set(300...599))
        let response: HTTPResponse
        do { response = try await http.send(request) } catch { return nil }
        if response.status >= 500 { return nil }
        guard (200..<300).contains(response.status) else {
            if response.status == 409 { identity = nil }
            throw BackupError.http(response.status, conflict: response.status == 409)
        }
        return response.text
    }
}
