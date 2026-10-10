import Foundation

// One video as the list page describes it (packages/app routes/nativeViewer.ts): the provider's
// own fields, which go back to the page unchanged, plus what the viewer knows without asking.
struct ViewerVideo {
    private(set) var raw: [String: Any]

    init?(_ value: Any?) {
        guard let raw = value as? [String: Any], let filename = raw["filename"] as? String, !filename.isEmpty,
              raw["provider"] is String else { return nil }
        self.raw = raw
    }

    var filename: String { raw["filename"] as! String }
    var provider: String { raw["provider"] as! String }
    var type: String { raw["type"] as? String ?? "original" }
    var title: String? { raw["title"] as? String }
    var pageUrl: String? { raw["pageUrl"] as? String }
    var isLive: Bool { raw["isLive"] as? Bool ?? false }
    var following: Bool { raw["following"] as? Bool ?? false }
    var parent: String? { raw["parent"] as? String }
    // A PC recording (save, cut, return; the PC playlist's timeline) and a live provider's stream.
    var local: Bool { raw["local"] as? Bool ?? false }
    var liveStream: Bool { raw["live"] as? Bool ?? false }
    var media: MediaSource? { MediaSource(raw["media"]) }
    var membership: MembershipInfo? { MembershipInfo(raw["membership"]) }

    var key: String { filename + "\u{1F}" + type }
    var name: String { title ?? filename }
    var edited: Bool { type == "edited" }

    func same(_ other: ViewerVideo) -> Bool { filename == other.filename && type == other.type }

    func setting(_ field: String, _ value: Any) -> ViewerVideo {
        var copy = self
        copy.raw[field] = value
        if field == "type" { copy.raw.removeValue(forKey: "media") }
        return copy
    }
}

struct MediaSource {
    let url: URL
    let kind: String

    init(url: URL, kind: String) {
        self.url = url
        self.kind = kind
    }

    init?(_ value: Any?) {
        guard let raw = value as? [String: Any], let text = raw["url"] as? String, let url = URL(string: text),
              url.scheme == "https" || url.scheme == "http" else { return nil }
        self.url = url
        kind = raw["kind"] as? String ?? "hls"
    }
}

// The streamer the +/- button adds to or removes from the PC's download lists. `choose`: Video
// Vault's uploads, which can belong to any of the lists.
struct MembershipInfo {
    let lists: [String]
    let identifier: String
    let choose: Bool

    init?(_ value: Any?) {
        guard let raw = value as? [String: Any], let lists = raw["lists"] as? [String], !lists.isEmpty,
              let identifier = raw["identifier"] as? String, !identifier.isEmpty else { return nil }
        self.lists = lists
        self.identifier = identifier
        choose = raw["choose"] as? Bool ?? false
    }
}

// Where each video was left, by filename, as the web viewer kept it in localStorage (whose
// values seed this store). Live streams keep none.
@MainActor
final class ProgressStore {
    private let url: URL
    private var values: [String: Double]
    private var dirty = false

    init(directory: URL) {
        url = directory.appendingPathComponent("viewer-progress.json")
        values = (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Double] } ?? [:]
    }

    func time(_ filename: String) -> Double { values[filename] ?? 0 }

    // The page's saved positions for videos this store has never seen.
    func seed(_ progress: [String: Any]) {
        for (filename, value) in progress where values[filename] == nil {
            if let time = (value as? NSNumber)?.doubleValue, time.isFinite, time > 0 { values[filename] = time; dirty = true }
        }
    }

    func set(_ filename: String, _ time: Double) {
        guard time.isFinite, time >= 0, values[filename] != time else { return }
        values[filename] = time
        dirty = true
    }

    func flush() {
        guard dirty else { return }
        dirty = false
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: values).write(to: url, options: .atomic)
        } catch { print("Viewer progress:", error) }
    }
}

// The open viewer, so a killed app reopens it like a restored Safari tab reopens its page.
struct ViewerCheckpoint {
    let provider: String
    let videos: [ViewerVideo]
    let current: String

    private static func url(_ directory: URL) -> URL { directory.appendingPathComponent("viewer-checkpoint.json") }

    static func load(_ directory: URL) -> ViewerCheckpoint? {
        guard let data = try? Data(contentsOf: url(directory)),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let provider = raw["provider"] as? String, let current = raw["current"] as? String,
              let videos = (raw["videos"] as? [Any])?.compactMap(ViewerVideo.init), !videos.isEmpty else { return nil }
        return ViewerCheckpoint(provider: provider, videos: videos, current: current)
    }

    func save(_ directory: URL) {
        let raw: [String: Any] = ["provider": provider, "current": current, "videos": videos.map(\.raw)]
        guard JSONSerialization.isValidJSONObject(raw) else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: raw).write(to: Self.url(directory), options: .atomic)
        } catch { print("Viewer checkpoint:", error) }
    }

    static func clear(_ directory: URL) { try? FileManager.default.removeItem(at: url(directory)) }
}
