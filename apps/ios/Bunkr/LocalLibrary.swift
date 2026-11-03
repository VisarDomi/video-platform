import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum LocalMediaKind: String, Sendable {
    case hls, file, mp4 // mp4 remains readable for older saved/configured descriptors.
    var originalFile: Bool { self != .hls }
}

// A recording as the PC lists it.
struct ServerVideo: Codable, Sendable, Equatable {
    var filename: String
    var type: String
    var size: Double
    var duration: Double
    var isLive: Bool
    var fileId: String? = nil
    var width: Double? = nil
    var height: Double? = nil
    var videoCodec: String? = nil
    var frameRate: Double? = nil

    var key: String { (fileId ?? filename) + "\u{1F}" + type }

    // The PC's order: the filename's UTF-16 code units (JavaScript's `<`), then the type.
    static func precedes(_ a: ServerVideo, _ b: ServerVideo) -> Bool {
        if a.filename != b.filename { return a.filename.utf16.lexicographicallyPrecedes(b.filename.utf16) }
        return a.type.utf16.lexicographicallyPrecedes(b.type.utf16)
    }
}

extension Array where Element == ServerVideo {
    func insertionIndex(for item: ServerVideo) -> Int {
        var low = 0, high = count
        while low < high {
            let middle = (low + high) / 2
            if ServerVideo.precedes(self[middle], item) { low = middle + 1 } else { high = middle }
        }
        return low
    }
}

struct ListCache: Codable {
    var provider: String
    var epoch: String
    var revision: Int
    var videos: [ServerVideo]
}

struct LocalProgressMigration: Equatable, Sendable {
    var filename: String
    var fileId: String
}

// Old caches keyed progress by filename. Only those legacy rows need matching;
// already identified libraries must not pay a full-library scan for every row.
func localProgressMigrations(from current: [ServerVideo], to next: [ServerVideo]) -> [LocalProgressMigration] {
    // HLS recording providers have no file IDs; avoid allocating an index they
    // will never consult. This is the usual path for SC, FC2 and Tango local.
    guard next.contains(where: { $0.fileId != nil }) else { return [] }
    struct Identity: Hashable {
        var filename: String
        var size: Double
        var duration: Double
        init(_ video: ServerVideo) {
            filename = video.filename; size = video.size; duration = video.duration
        }
    }
    let legacy = Set(current.lazy.filter { $0.fileId == nil }.map(Identity.init))
    guard !legacy.isEmpty else { return [] }
    return next.compactMap { video in
        guard let id = video.fileId, legacy.contains(Identity(video)) else { return nil }
        return LocalProgressMigration(filename: video.filename, fileId: id)
    }
}

struct ChangeSet: Decodable {
    struct Removed: Decodable { var filename: String; var type: String }
    struct Change: Decodable { var revision: Int; var item: ServerVideo?; var removed: Removed? }
    var epoch: String
    var revision: Int
    var videos: [ServerVideo]?
    var changes: [Change]?
}

struct LocalRenameResult: Decodable {
    var video: ServerVideo
    var epoch: String
    var revision: Int
}

struct LocalRevisionBarrier {
    var epoch: String
    var revision: Int
    func permits(_ set: ChangeSet) -> Bool { set.epoch != epoch || set.revision >= revision }
}

struct LocalLibraryFailure: LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

func localMP4Name(_ value: String, extension fileExtension: String = "mp4") throws -> String {
    var name = value.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
    guard !name.isEmpty, !name.hasPrefix("."), !name.contains("/"), !name.contains("\\"),
          !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else {
        throw LocalLibraryFailure(message: "Use a filename without folders or control characters.")
    }
    if !name.lowercased().hasSuffix("." + fileExtension) { name += "." + fileExtension }
    guard name.utf8.count <= 255 else { throw LocalLibraryFailure(message: "The filename is too long.") }
    return name
}

func mergingLocalVideos(_ current: [ServerVideo], _ set: ChangeSet) -> [ServerVideo] {
    if let videos = set.videos { return videos.sorted(by: ServerVideo.precedes) }
    var items = current
    for change in set.changes ?? [] {
        if let removed = change.removed { items.removeAll { $0.filename == removed.filename && $0.type == removed.type } }
        else if let item = change.item {
            items.removeAll { $0.key == item.key || ($0.filename == item.filename && $0.type == item.type) }
            items.insert(item, at: items.insertionIndex(for: item))
        }
    }
    return items
}

// The PC's recordings API for one provider (packages/server video.routes.ts, library-index.ts).
struct LocalAPI: Sendable {
    let server: URL
    let provider: String
    let mediaKind: LocalMediaKind
    private let transport: URLSession
    private static let sharedSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 45
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    init(server: URL, provider: String, mediaKind: LocalMediaKind = .hls, session: URLSession? = nil) {
        self.server = URL(string: "/", relativeTo: server)!.absoluteURL
        self.provider = provider
        self.mediaKind = mediaKind
        transport = session ?? Self.sharedSession
    }

    func mediaURL(_ filename: String, fileId: String? = nil) -> URL {
        if mediaKind.originalFile, let fileId { return server.appendingPathComponent("media").appendingPathComponent(provider).appendingPathComponent("id").appendingPathComponent(fileId) }
        if mediaKind.originalFile { return server.appendingPathComponent("media").appendingPathComponent(provider).appendingPathComponent(filename) }
        return server.appendingPathComponent("hls").appendingPathComponent(provider).appendingPathComponent(filename).appendingPathComponent("playlist.m3u8")
    }

    // What changed since `revision` of `epoch`, waiting up to `wait` seconds for a change.
    func changes(epoch: String?, since revision: Int?, wait: Int) async throws -> ChangeSet {
        var components = URLComponents(url: server.appendingPathComponent("api/videos/changes"), resolvingAgainstBaseURL: false)!
        var query = [URLQueryItem(name: "provider", value: provider), URLQueryItem(name: "wait", value: String(wait))]
        if let epoch, let revision { query += [URLQueryItem(name: "epoch", value: epoch), URLQueryItem(name: "since", value: String(revision))] }
        components.queryItems = query
        var request = URLRequest(url: components.url!)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await transport.data(for: request)
        // The server answers unknown paths with its web page and status 200.
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.value(forHTTPHeaderField: "Content-Type")?.contains("application/json") == true else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(ChangeSet.self, from: data)
    }

    func rename(_ video: ServerVideo, to proposed: String) async throws -> LocalRenameResult {
        guard provider == "bunkr", mediaKind.originalFile, let id = video.fileId else { throw LocalLibraryFailure(message: "Reconnect to the PC before renaming this video.") }
        let name = try localMP4Name(proposed, extension: (video.filename as NSString).pathExtension.lowercased())
        let endpoint = server.appendingPathComponent("api/bunkr/files").appendingPathComponent(id)
        var request = URLRequest(url: endpoint.appendingPathComponent("rename"), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("1", forHTTPHeaderField: "X-Video-Library")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["filename": video.filename, "name": name])
        do { return try await renameReply(request) }
        catch {
            // Read after a lost acknowledgement, without issuing a second automatic mutation.
            let lookup = URLRequest(url: endpoint, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
            if let confirmed = try? await renameReply(lookup), confirmed.video.filename == name { return confirmed }
            throw error
        }
    }

    private func renameReply(_ request: URLRequest) async throws -> LocalRenameResult {
        let (data, response) = try await transport.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200...299).contains(http.statusCode) else {
            let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw LocalLibraryFailure(message: error?["error"] as? String ?? "The PC could not rename this video.")
        }
        return try JSONDecoder().decode(LocalRenameResult.self, from: data)
    }

    // As the website's nativeViewer.ts describe(): a local recording with its PC playlist and
    // its streamer for the +/- button.
    func describeRaw(_ video: ServerVideo) -> [String: Any] {
        let parts = video.filename.split(separator: " ", omittingEmptySubsequences: false)
        let identifier = parts.count >= 3 ? parts[2...].joined(separator: " ") : video.filename
        var raw: [String: Any] = [
            "filename": video.filename, "type": video.type, "size": video.size, "duration": video.duration, "isLive": video.isLive,
            // `local` means the recording playlist/edit contract in the shared viewer.
            // Original files use its VOD playback path, without streamer/edit actions.
            "provider": provider, "local": mediaKind == .hls, "live": false,
            "media": ["url": mediaURL(video.filename, fileId: video.fileId).absoluteString, "kind": mediaKind.rawValue],
        ]
        if let fileId = video.fileId { raw["fileId"] = fileId }
        if let codec = video.videoCodec { raw["videoCodec"] = codec }
        if let fps = video.frameRate { raw["frameRate"] = fps }
        if let width = video.width, let height = video.height, width.isFinite, height.isFinite, width > 0, height > 0 {
            raw["displayWidth"] = width
            raw["displayHeight"] = height
        }
        if mediaKind == .hls { raw["membership"] = ["lists": [provider], "identifier": identifier, "choose": false] }
        return raw
    }
}
