import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum LocalMediaKind: String, Sendable { case hls, mp4 }

// A recording as the PC lists it.
struct ServerVideo: Codable, Sendable, Equatable {
    var filename: String
    var type: String
    var size: Double
    var duration: Double
    var isLive: Bool

    var key: String { filename + "\u{1F}" + type }

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

struct ChangeSet: Decodable {
    struct Removed: Decodable { var filename: String; var type: String }
    struct Change: Decodable { var revision: Int; var item: ServerVideo?; var removed: Removed? }
    var epoch: String
    var revision: Int
    var videos: [ServerVideo]?
    var changes: [Change]?
}

// The PC's recordings API for one provider (packages/server video.routes.ts, library-index.ts).
struct LocalAPI: Sendable {
    let server: URL
    let provider: String
    let mediaKind: LocalMediaKind
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 45
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    init(server: URL, provider: String, mediaKind: LocalMediaKind = .hls) {
        self.server = URL(string: "/", relativeTo: server)!.absoluteURL
        self.provider = provider
        self.mediaKind = mediaKind
    }

    func mediaURL(_ filename: String) -> URL {
        if mediaKind == .mp4 { return server.appendingPathComponent("media").appendingPathComponent(provider).appendingPathComponent(filename) }
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
        let (data, response) = try await Self.session.data(for: request)
        // The server answers unknown paths with its web page and status 200.
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.value(forHTTPHeaderField: "Content-Type")?.contains("application/json") == true else { throw URLError(.badServerResponse) }
        return try JSONDecoder().decode(ChangeSet.self, from: data)
    }

    // As the website's nativeViewer.ts describe(): a local recording with its PC playlist and
    // its streamer for the +/- button.
    func describeRaw(_ video: ServerVideo) -> [String: Any] {
        let parts = video.filename.split(separator: " ", omittingEmptySubsequences: false)
        let identifier = parts.count >= 3 ? parts[2...].joined(separator: " ") : video.filename
        var raw: [String: Any] = [
            "filename": video.filename, "type": video.type, "size": video.size, "duration": video.duration, "isLive": video.isLive,
            // `local` means the recording playlist/edit contract in the shared viewer.
            // Flat MP4s use its Video Vault playback path, without streamer/edit actions.
            "provider": provider, "local": mediaKind == .hls, "live": false,
            "media": ["url": mediaURL(video.filename).absoluteString, "kind": mediaKind.rawValue],
        ]
        if mediaKind == .hls { raw["membership"] = ["lists": [provider], "identifier": identifier, "choose": false] }
        return raw
    }
}
