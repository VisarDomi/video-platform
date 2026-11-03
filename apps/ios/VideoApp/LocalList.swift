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
    private var feedGeneration = 0
    private var active = true
    private var mutationGeneration = 0
    private var renameBarrier: LocalRevisionBarrier?
    private let network = NWPathMonitor()
    private let cacheWriter: BackgroundWriter

    init(provider: String, server: URL, mediaKind: LocalMediaKind = .hls) {
        self.provider = provider
        api = LocalAPI(server: server, provider: provider, mediaKind: mediaKind)
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
        feedGeneration += 1
        let feed = feedGeneration
        following = Task { [weak self] in
            var delay = 1.0
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let generation = mutationGeneration
                    let set = try await api.changes(epoch: epoch, since: revision, wait: loaded ? 25 : 0)
                    guard !Task.isCancelled else { break }
                    await apply(set, requestGeneration: generation)
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
            if let self, self.feedGeneration == feed { self.following = nil }
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
    private func permits(_ set: ChangeSet, requestGeneration: Int) -> Bool {
        if requestGeneration != mutationGeneration {
            guard let barrier = renameBarrier, set.epoch == barrier.epoch, set.revision >= barrier.revision else { return false }
        }
        return renameBarrier?.permits(set) ?? true
    }

    private func apply(_ set: ChangeSet, requestGeneration: Int) async {
        guard !Task.isCancelled, permits(set, requestGeneration: requestGeneration) else { return }
        let changed = set.videos != nil || !(set.changes ?? []).isEmpty || !loaded
        let moved = set.epoch != epoch || set.revision != revision
        let (current, api) = (items, api)
        let result: (items: [ServerVideo], rows: [ViewerVideo], looks: [ViewerVideo.Look])? = changed ? await Task.detached(priority: .userInitiated) {
            let items = mergingLocalVideos(current, set)
            let rows = items.map(api.describe)
            return (items, rows, rows.map(\.look))
        }.value : nil
        guard !Task.isCancelled, permits(set, requestGeneration: requestGeneration) else { return }
        epoch = set.epoch
        revision = set.revision
        if let result {
            publish(result.items, rows: result.rows, looks: result.looks)
        }
        if changed || moved { cacheWriter.save(json: ListCache(provider: provider, epoch: set.epoch, revision: set.revision, videos: items)) }
    }

    private func publish(_ next: [ServerVideo], rows: [ViewerVideo]? = nil, looks: [ViewerVideo.Look]? = nil) {
        let highlighted = items.first { $0.filename == highlight }
        for item in next {
            if let id = item.fileId, items.contains(where: { $0.fileId == nil && $0.filename == item.filename && $0.size == item.size && $0.duration == item.duration }) {
                progress.migrate(from: item.filename, to: id)
            }
        }
        items = next
        setVideos(rows ?? next.map(api.describe), looks: looks)
        if let highlighted, let id = highlighted.fileId, let renamed = next.first(where: { $0.fileId == id }), renamed.filename != highlighted.filename {
            highlight(renamed.filename, reveal: false)
        }
    }

    override func rename(_ video: ViewerVideo, to name: String) async throws -> ViewerVideo {
        guard provider == "bunkr", let id = video.fileId else { throw LocalLibraryFailure(message: "Reconnect to the PC before renaming this video.") }
        let selected = ServerVideo(filename: video.filename, type: video.type, size: video.size,
                                   duration: (video.raw["duration"] as? NSNumber)?.doubleValue ?? 0, isLive: false, fileId: id)
        do {
            let result = try await api.rename(selected, to: name)
            mutationGeneration += 1; renameBarrier = LocalRevisionBarrier(epoch: result.epoch, revision: result.revision)
            var next = items.filter { $0.fileId != id && !($0.fileId == nil && $0.filename == video.filename && $0.type == video.type) }
            next.insert(result.video, at: next.insertionIndex(for: result.video)); publish(next)
            cacheWriter.save(json: ListCache(provider: provider, epoch: epoch ?? "", revision: revision ?? 0, videos: items))
            return api.describe(result.video)
        } catch { reload(); throw error }
    }

    // The web version kept the last viewed row and the web viewer's positions in the website's
    // localStorage; read them once (from the PC's page, so only while it answers).
    private func migrateWebStorage() {
        guard api.mediaKind == .hls else { return }
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

    override func changed(_ video: ViewerVideo) {
        guard items.contains(where: { $0.filename == video.filename }) else { return }
        // OK/Cut/Return is a confirmed variant change, not a second recording.
        // An older in-flight list response cannot undo its acknowledged result.
        mutationGeneration += 1
        renameBarrier = nil
        let item = ServerVideo(filename: video.filename, type: video.type, size: video.size,
                               duration: (video.raw["duration"] as? NSNumber)?.doubleValue ?? 0, isLive: video.isLive,
                               fileId: video.fileId, width: video.displaySize.map { Double($0.width) },
                               height: video.displaySize.map { Double($0.height) }, videoCodec: video.raw["videoCodec"] as? String,
                               frameRate: (video.raw["frameRate"] as? NSNumber)?.doubleValue)
        var next = items.filter { $0.filename != video.filename }
        next.insert(item, at: next.insertionIndex(for: item))
        publish(next)
        cacheWriter.save(json: ListCache(provider: provider, epoch: epoch ?? "", revision: revision ?? 0, videos: items))
    }

    // Local recordings always have their source; asked anyway, it is the PC's playlist.
    override func resolve(_ video: ViewerVideo) async throws -> MediaSource {
        if let media = video.media { return media }
        return MediaSource(url: api.mediaURL(video.filename), kind: api.mediaKind.rawValue)
    }
}

// UI adaptation stays here; the API/cache models are Foundation-only in LocalLibrary.swift.
extension LocalAPI {
    func describe(_ video: ServerVideo) -> ViewerVideo { ViewerVideo(describeRaw(video))! }
}
