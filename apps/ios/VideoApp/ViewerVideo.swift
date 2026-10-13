import Foundation
import UIKit
import KitCore

// One video as the list page describes it (packages/app routes/nativeViewer.ts): the provider's
// own fields, which go back to the page unchanged, plus what the viewer knows without asking.
// Its fields are JSON values, never changed in place: safe to build off the main thread.
struct ViewerVideo: @unchecked Sendable {
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

    // What its row shows (VideoRowCell.show): two lists whose rows look the same need no reload.
    struct Look: Equatable, Sendable {
        var filename: String
        var type: String
        var name: String
        var isLive: Bool
        var liveStream: Bool
        var duration: Double
    }

    var look: Look {
        Look(filename: filename, type: type, name: name, isLive: isLive, liveStream: liveStream, duration: (raw["duration"] as? NSNumber)?.doubleValue ?? 0)
    }

    func setting(_ field: String, _ value: Any) -> ViewerVideo {
        var copy = self
        copy.raw[field] = value
        // A PC recording's playlist URL names the recording, not its type (the server finds the
        // edited or original folder), so it stays; an online video's source must be asked again.
        if field == "type" && !local { copy.raw.removeValue(forKey: "media") }
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
// values seed this store). Live streams keep none. Every change is written at once, off the
// main thread (newest first), so a kill or power-off loses at most the last few seconds.
@MainActor
final class ProgressStore {
    private let writer: BackgroundWriter
    private var values: [String: Double]

    init(directory: URL) {
        writer = BackgroundWriter(url: directory.appendingPathComponent("viewer-progress.json"), label: "viewer-progress")
        values = (try? Data(contentsOf: writer.url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Double] } ?? [:]
    }

    func time(_ filename: String) -> Double { values[filename] ?? 0 }

    // The page's saved positions for videos this store has never seen.
    func seed(_ progress: [String: Any]) {
        var changed = false
        for (filename, value) in progress where values[filename] == nil {
            if let time = (value as? NSNumber)?.doubleValue, time.isFinite, time > 0 { values[filename] = time; changed = true }
        }
        if changed { save() }
    }

    func set(_ filename: String, _ time: Double) {
        guard time.isFinite, time >= 0, values[filename] != time else { return }
        values[filename] = time
        save()
    }

    // Waits for the last write (before the app may be suspended).
    func flush() { writer.flush() }

    private func save() {
        let snapshot = values
        writer.save { try JSONSerialization.data(withJSONObject: snapshot) }
    }
}

// The open viewer, so a killed app reopens it like a restored Safari tab reopens its page.
struct ViewerCheckpoint {
    let provider: String
    let videos: [ViewerVideo]
    let current: String

    fileprivate static func url(_ directory: URL) -> URL { directory.appendingPathComponent("viewer-checkpoint.json") }

    static func load(_ directory: URL) -> ViewerCheckpoint? {
        guard let data = try? Data(contentsOf: url(directory)),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let provider = raw["provider"] as? String, let current = raw["current"] as? String,
              let videos = (raw["videos"] as? [Any])?.compactMap(ViewerVideo.init), !videos.isEmpty else { return nil }
        return ViewerCheckpoint(provider: provider, videos: videos, current: current)
    }

    fileprivate var raw: [String: Any] { ["provider": provider, "current": current, "videos": videos.map(\.raw)] }
}

// The picture on screen when the app left it, where it was and whether the controls showed
// (viewer-poster.jpg and .json): a relaunch into the viewer shows it in its first frame, until
// the player has its own first picture of the same video.
struct ViewerPoster: Codable {
    let key: String
    let frame: [Double]
    let controls: Bool

    static func image(_ directory: URL) -> URL { directory.appendingPathComponent("viewer-poster.jpg") }
    static func info(_ directory: URL) -> URL { directory.appendingPathComponent("viewer-poster.json") }

    static func load(_ directory: URL) -> (poster: ViewerPoster, image: UIImage)? {
        guard let poster = try? DurableFile.readJSON(ViewerPoster.self, from: info(directory)), poster.frame.count == 4,
              let image = UIImage(contentsOfFile: image(directory).path) else { return nil }
        return (poster, image)
    }

    static func save(_ poster: ViewerPoster, jpeg: Data, in directory: URL) {
        try? DurableFile.write(jpeg, to: image(directory))
        try? DurableFile.writeJSON(poster, to: info(directory))
    }

    static func clear(_ directory: URL) {
        try? FileManager.default.removeItem(at: info(directory))
        try? FileManager.default.removeItem(at: image(directory))
    }
}

// Saves the checkpoint off the main thread, newest first. Every swipe saves it, and a long list
// takes a while to encode (Tango's 4,000 recordings, about 60 ms on the phone): long enough to
// stutter the swipe that saved it.
// The poster (encoded and written) and its removal go through the same queue, in order.
final class CheckpointWriter: @unchecked Sendable {
    let directory: URL
    private let queue = DispatchQueue(label: "viewer-checkpoint", qos: .utility)
    private let lock = NSLock()
    private var pending: ViewerCheckpoint?

    init(directory: URL) { self.directory = directory }

    func save(_ checkpoint: ViewerCheckpoint) {
        lock.withLock { pending = checkpoint }
        queue.async { self.write() }
    }

    func clear() {
        lock.withLock { pending = nil }
        queue.async { try? FileManager.default.removeItem(at: ViewerCheckpoint.url(self.directory)) }
    }

    func savePoster(_ poster: ViewerPoster, image: UIImage) {
        queue.async {
            guard let jpeg = image.jpegData(compressionQuality: 0.85) else { return }
            ViewerPoster.save(poster, jpeg: jpeg, in: self.directory)
        }
    }

    func clearPoster() { queue.async { ViewerPoster.clear(self.directory) } }

    // Waits for the last save: the app may be suspended next.
    func flush() { queue.sync {} }

    private func write() {
        guard let raw = lock.withLock({ () -> ViewerCheckpoint? in
            defer { pending = nil }
            return pending
        })?.raw, JSONSerialization.isValidJSONObject(raw) else { return }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: raw).write(to: ViewerCheckpoint.url(directory), options: .atomic)
        } catch { print("Viewer checkpoint:", error) }
    }
}
