import Network
import UIKit
import KitCore
import KitMigration

// A local app's list (Tango local, FC2 local, SC local): the PC's recordings for one provider,
// as the website's list showed them. The list is kept on the phone (`list-cache.json`, written
// on every change), so it shows at once at launch, offline and after a kill; the PC's change
// feed (`/api/videos/changes`, one long-polling request at a time while the app is on screen)
// brings each new recording, finished recording, edit and deletion within a second, placed
// where it belongs without moving the rows on screen.
@MainActor
final class LocalListController: VideoListController {
    private let provider: String
    private let api: LocalAPI
    private var items: [ServerVideo] = []
    private var epoch: String?
    private var revision: Int?
    private var following: Task<Void, Never>?
    private var active = true
    private let network = NWPathMonitor()
    private let cacheWriter: BackgroundWriter

    init(provider: String, server: URL) {
        self.provider = provider
        api = LocalAPI(server: server, provider: provider)
        let directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/LocalVideos")
        cacheWriter = BackgroundWriter(url: directory.appendingPathComponent("list-cache.json"), label: "list-cache")
        super.init(viewerProvider: provider, directory: directory, media: ViewerMedia())
        if let cache = try? DurableFile.readJSON(ListCache.self, from: cacheWriter.url), cache.provider == provider {
            epoch = cache.epoch
            revision = cache.revision
            items = cache.videos
            setVideos(items.map(api.describe))
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override func viewDidLoad() {
        super.viewDidLoad()
        network.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.follow() }
        }
        network.start(queue: DispatchQueue(label: "LocalList.network"))
        follow()
        migrateWebStorage()
        DebugState.shared.register("feed") { [weak self] in ["revision": self?.revision ?? -1] }
    }

    // MARK: app lifecycle (from SceneDelegate)

    func resumed(afterBackground: Bool) {
        active = true
        follow()
    }

    func paused() {
        active = false
        following?.cancel()
        following = nil
        flushState()
        cacheWriter.flush()
    }

    // MARK: following the PC

    // One long-polling request at a time while on screen: the answer is either the whole list
    // (first time, after the PC restarted, or too far behind) or only what changed.
    private func follow() {
        guard following == nil, active else { return }
        following = Task { [weak self] in
            var delay = 1.0
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let set = try await api.changes(epoch: epoch, since: revision, wait: loaded ? 25 : 0)
                    guard !Task.isCancelled else { break }
                    await apply(set)
                    guard !Task.isCancelled else { break }
                    hideFailure()
                    refresh.endRefreshing()
                    delay = 1
                } catch {
                    guard !Task.isCancelled else { break }
                    refresh.endRefreshing()
                    if !loaded { showFailure("Can't reach your PC.\n\(error.localizedDescription)") }
                    try? await Task.sleep(for: .seconds(delay))
                    delay = min(delay * 2, 30)
                }
            }
            self?.following = nil
        }
    }

    // Pulling down asks for the whole list again.
    override func reload() {
        following?.cancel()
        following = nil
        epoch = nil
        revision = nil
        follow()
    }

    // The changes are applied, and the rows described, off the main thread (a live recording
    // changes every few seconds and the list holds thousands); only the result is set.
    private func apply(_ set: ChangeSet) async {
        let changed = set.videos != nil || !(set.changes ?? []).isEmpty || !loaded
        let moved = set.epoch != epoch || set.revision != revision
        let (current, api) = (items, api)
        let result: (items: [ServerVideo], rows: [ViewerVideo], looks: [ViewerVideo.Look])? = changed ? await Task.detached(priority: .userInitiated) {
            var items = set.videos ?? current
            if set.videos == nil {
                for change in set.changes ?? [] {
                    if let removed = change.removed {
                        items.removeAll { $0.filename == removed.filename && $0.type == removed.type }
                    } else if let item = change.item {
                        if let index = items.firstIndex(where: { $0.filename == item.filename && $0.type == item.type }) { items[index] = item }
                        else { items.insert(item, at: items.insertionIndex(for: item)) }
                    }
                }
            }
            let rows = items.map(api.describe)
            return (items, rows, rows.map(\.look))
        }.value : nil
        epoch = set.epoch
        revision = set.revision
        if let result {
            items = result.items
            setVideos(result.rows, looks: result.looks)
        }
        if changed || moved { cacheWriter.save(json: ListCache(provider: provider, epoch: set.epoch, revision: set.revision, videos: items)) }
    }

    // The web version kept the last viewed row and the web viewer's positions in the website's
    // localStorage; read them once (from the PC's page, so only while it answers).
    private func migrateWebStorage() {
        let marker = directory.appendingPathComponent("web-storage-migrated")
        guard !FileManager.default.fileExists(atPath: marker.path), let page = URL(string: "/videos/\(provider)", relativeTo: api.server) else { return }
        let reader = WebStorageReader()
        Task { [weak self, provider] in
            let script = "return Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith('video-progress-') || k.startsWith('video-highlight:')))"
            guard let values = try? await reader.read(page.absoluteURL, script: script) as? [String: Any], let self else { return }
            var progress: [String: Any] = [:]
            for (key, value) in values where key.hasPrefix("video-progress-") {
                if let seconds = Double(value as? String ?? "") ?? (value as? NSNumber)?.doubleValue {
                    progress[String(key.dropFirst("video-progress-".count))] = seconds
                }
            }
            self.progress.seed(progress)
            self.progress.flush()
            if self.highlight == nil, let filename = values["video-highlight:\(provider)"] as? String { self.highlight(filename, reveal: true) }
            try? DurableFile.write(Data(), to: marker)
        }
    }

    // MARK: ViewerHost

    // Local recordings always have their source; asked anyway, it is the PC's playlist.
    override func resolve(_ video: ViewerVideo) async throws -> MediaSource {
        if let media = video.media { return media }
        return MediaSource(url: api.playlist(video.filename), kind: "hls")
    }
}

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
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 45
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        return URLSession(configuration: configuration)
    }()

    init(server: URL, provider: String) {
        self.server = server
        self.provider = provider
    }

    func playlist(_ filename: String) -> URL {
        server.appendingPathComponent("hls").appendingPathComponent(provider).appendingPathComponent(filename).appendingPathComponent("playlist.m3u8")
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
    func describe(_ video: ServerVideo) -> ViewerVideo {
        let parts = video.filename.split(separator: " ", omittingEmptySubsequences: false)
        let identifier = parts.count >= 3 ? parts[2...].joined(separator: " ") : video.filename
        let raw: [String: Any] = [
            "filename": video.filename, "type": video.type, "size": video.size, "duration": video.duration, "isLive": video.isLive,
            "provider": provider, "local": true, "live": false,
            "media": ["url": playlist(video.filename).absoluteString, "kind": "hls"],
            "membership": ["lists": [provider], "identifier": identifier, "choose": false],
        ]
        return ViewerVideo(raw)!
    }
}
