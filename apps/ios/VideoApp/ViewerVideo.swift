import Foundation
import UIKit
import KitCore

// One video as a list describes it (LocalList, VaultList, TangoList): the provider's own fields,
// kept as they came, plus what the viewer knows without asking.
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
    var needsAlternateDecoder: Bool {
        let codec = (raw["videoCodec"] as? String ?? "").lowercased()
        let container = (filename as NSString).pathExtension.lowercased()
        return ["av1", "vp9", "vp8"].contains(codec) || ["mkv", "webm", "avi", "ts"].contains(container)
    }
    var displaySize: CGSize? {
        if provider == "tango-live" { return CGSize(width: 720, height: 1280) }
        guard let width = raw["displayWidth"] as? Double, let height = raw["displayHeight"] as? Double,
              width.isFinite, height.isFinite, width > 0, height > 0 else { return nil }
        return CGSize(width: width, height: height)
    }

    var membership: MembershipInfo? { MembershipInfo(raw["membership"]) }

    var key: String { progressKey + "\u{1F}" + type }
    var name: String { title ?? filename }
    var size: Double { (raw["size"] as? NSNumber)?.doubleValue ?? 0 }
    var fileId: String? { raw["fileId"] as? String }
    var progressKey: String { fileId ?? filename }
    var canRename: Bool { provider == "bunkr" && fileId != nil }
    var edited: Bool { type == "edited" }

    func same(_ other: ViewerVideo) -> Bool {
        if let id = fileId, let otherId = other.fileId { return id == otherId && type == other.type }
        return filename == other.filename && type == other.type
    }

    func sameRecording(_ other: ViewerVideo) -> Bool {
        guard provider == other.provider else { return false }
        if let id = fileId, let otherId = other.fileId { return id == otherId }
        return filename == other.filename
    }

    // What its row shows (VideoRowCell.show): two lists whose rows look the same need no reload.
    struct Look: Equatable, Sendable {
        var filename: String
        var type: String
        var name: String
        var isLive: Bool
        var liveStream: Bool
        var duration: Double
        var size: Double = 0
    }

    var look: Look {
        Look(filename: filename, type: type, name: name, isLive: isLive, liveStream: liveStream, duration: (raw["duration"] as? NSNumber)?.doubleValue ?? 0, size: size)
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
    let displaySize: CGSize?

    init(url: URL, kind: String, displaySize: CGSize? = nil) {
        self.url = url
        self.kind = kind
        self.displaySize = displaySize
    }

    init?(_ value: Any?) {
        guard let raw = value as? [String: Any], let text = raw["url"] as? String, let url = URL(string: text),
              url.scheme == "https" || url.scheme == "http" else { return nil }
        self.url = url
        kind = raw["kind"] as? String ?? "hls"
        displaySize = nil
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
    private let sizesWriter: BackgroundWriter
    private var sizes: [String: [Double]]

    init(directory: URL) {
        writer = BackgroundWriter(url: directory.appendingPathComponent("viewer-progress.json"), label: "viewer-progress")
        values = (try? Data(contentsOf: writer.url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Double] } ?? [:]
        sizesWriter = BackgroundWriter(url: directory.appendingPathComponent("viewer-dimensions.json"), label: "viewer-dimensions")
        sizes = (try? Data(contentsOf: sizesWriter.url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: [Double]] } ?? [:]
    }

    func time(_ filename: String) -> Double { values[filename] ?? 0 }
    func migrate(from old: String, to new: String) {
        if old != new {
            for type in ["original", "edited"] {
                let prior = old + "\u{1F}" + type, next = new + "\u{1F}" + type
                if sizes[next] == nil, let size = sizes[prior] { sizes[next] = size; sizesWriter.save(json: sizes) }
            }
        }
        guard old != new, values[new] == nil, let value = values[old] else { return }
        values[new] = value; save()
    }

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
    func flush() { writer.flush(); sizesWriter.flush() }

    func displaySize(_ key: String) -> CGSize? {
        guard let size = sizes[key], size.count == 2, size.allSatisfy({ $0.isFinite && $0 >= 32 && $0 <= 100_000 }) else { return nil }
        return CGSize(width: size[0], height: size[1])
    }

    func setDisplaySize(_ key: String, _ size: CGSize) {
        guard size.width.isFinite, size.height.isFinite, size.width >= 32, size.height >= 32 else { return }
        if let old = displaySize(key), abs(old.width / old.height - size.width / size.height) < 0.003 { return }
        sizes[key] = [Double(size.width), Double(size.height)]
        sizesWriter.save(json: sizes)
    }

    private func save() {
        let snapshot = values
        writer.save { try JSONSerialization.data(withJSONObject: snapshot) }
    }
}

// The open viewer, so a killed app reopens it like a restored Safari tab reopens its page.
struct ViewerCheckpoint {
    enum Visibility: String { case open, closed }
    let provider: String
    let videos: [ViewerVideo]
    let current: String
    var top: Double? = nil
    var zoom: ZoomState? = nil
    var controls: Bool? = nil
    var visibility = Visibility.open

    fileprivate static func url(_ directory: URL) -> URL { directory.appendingPathComponent("viewer-checkpoint.json") }

    static func load(_ directory: URL) -> ViewerCheckpoint? {
        guard let data = try? Data(contentsOf: url(directory)),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let provider = raw["provider"] as? String, let current = raw["current"] as? String,
              let videos = (raw["videos"] as? [Any])?.compactMap(ViewerVideo.init), !videos.isEmpty else { return nil }
        let zoom = (raw["zoom"] as? [String: Double]).flatMap { value -> ZoomState? in
            guard let scale = value["scale"], let x = value["x"], let y = value["y"] else { return nil }
            return ZoomState(scale: scale, x: x, y: y)
        }
        return ViewerCheckpoint(provider: provider, videos: videos, current: current, top: raw["top"] as? Double,
                                zoom: zoom, controls: raw["controls"] as? Bool,
                                visibility: (raw["visibility"] as? String).flatMap(Visibility.init(rawValue:)) ?? .open)
    }

    fileprivate var raw: [String: Any] {
        var result: [String: Any] = ["provider": provider, "current": current, "videos": videos.map(\.raw)]
        if let top, top.isFinite { result["top"] = top }
        if let zoom { result["zoom"] = ["scale": zoom.scale, "x": zoom.x, "y": zoom.y] }
        if let controls { result["controls"] = controls }
        result["visibility"] = visibility.rawValue
        return result
    }
}

// The picture on screen when the app left it, where it was and whether the controls showed
// (viewer-poster.jpg and .json): a relaunch into the viewer shows it in its first frame, until
// the player has its own first picture of the same video.
struct ViewerPoster: Codable {
    let key: String
    let frame: [Double]
    let controls: Bool
    var currentOnly: Bool? = nil

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
