import Network
import UIKit
import KitCore
import KitMigration

// A local app's list (Tango local, FC2 local, SC local): the PC's recordings for one provider,
// as the website's list showed them. The list is kept on the phone (`list-cache.json`, written
// on every change), so it shows at once at launch, offline and after a kill; the PC's change
// feed (`/api/videos/changes`, one long-polling request at a time while the app is on screen)
// brings each new recording, finished recording, edit and deletion within a second, placed
// where it belongs without moving the rows on screen. Rows open the native viewer over the
// list. The last viewed row is highlighted and centred at launch.
@MainActor
final class LocalListController: UIViewController, UITableViewDataSource, UITableViewDelegate, ViewerHost {
    struct State: Codable { var highlight: String? }

    private let provider: String
    private let api: LocalAPI
    private let directory: URL
    private let table = UITableView(frame: .zero, style: .plain)
    private let refresh = UIRefreshControl()
    private let status = UILabel()
    private let failure = UIStackView()
    private let message = UILabel()
    private var items: [ServerVideo] = []
    private var videos: [ViewerVideo] = []
    private var epoch: String?
    private var revision: Int?
    private var highlight: String?
    private var loaded = false
    private var centred = false
    private var following: Task<Void, Never>?
    private var active = true
    private let network = NWPathMonitor()
    private let media = ViewerMedia(store: nil, bridge: nil, tango: false)
    private let progress: ProgressStore
    private let checkpoint: CheckpointWriter
    private var viewer: ViewerController?
    private let stateWriter: BackgroundWriter
    private let cacheWriter: BackgroundWriter

    init(provider: String, server: URL) {
        self.provider = provider
        api = LocalAPI(server: server, provider: provider)
        directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/LocalVideos")
        progress = ProgressStore(directory: directory)
        checkpoint = CheckpointWriter(directory: directory)
        stateWriter = BackgroundWriter(url: directory.appendingPathComponent("list-state.json"))
        cacheWriter = BackgroundWriter(url: directory.appendingPathComponent("list-cache.json"), label: "list-cache")
        highlight = (try? DurableFile.readJSON(State.self, from: stateWriter.url))?.highlight
        super.init(nibName: nil, bundle: nil)
        if let cache = try? DurableFile.readJSON(ListCache.self, from: cacheWriter.url), cache.provider == provider {
            epoch = cache.epoch
            revision = cache.revision
            items = cache.videos
            videos = items.map(api.describe)
            loaded = true
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override var prefersStatusBarHidden: Bool { viewer?.prefersStatusBarHidden ?? false }
    override var childForStatusBarHidden: UIViewController? { viewer }
    override var childForHomeIndicatorAutoHidden: UIViewController? { viewer }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        table.backgroundColor = .black
        table.separatorStyle = .none
        table.rowHeight = VideoRowCell.height
        table.estimatedRowHeight = VideoRowCell.height
        table.contentInsetAdjustmentBehavior = .automatic
        table.dataSource = self
        table.delegate = self
        table.register(VideoRowCell.self, forCellReuseIdentifier: "row")
        refresh.addAction(UIAction { [weak self] _ in self?.reload() }, for: .valueChanged)
        table.refreshControl = refresh
        view.addSubview(table)
        status.textColor = UIColor(white: 0.67, alpha: 1)
        status.textAlignment = .center
        status.numberOfLines = 0
        status.text = loaded ? (videos.isEmpty ? "No videos found." : nil) : "Loading…"
        status.isHidden = status.text == nil
        view.addSubview(status)
        buildFailure()
        network.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.follow() }
        }
        network.start(queue: DispatchQueue(label: "LocalList.network"))
        restoreViewer()
        follow()
        migrateWebStorage()
        DebugState.shared.register("list") { [weak self] in
            guard let self else { return [:] }
            return ["provider": provider, "rows": videos.count, "revision": revision ?? -1, "highlight": highlight ?? "",
                    "viewer": viewer?.currentVideo?.filename ?? "", "offset": table.contentOffset.y,
                    "failure": failure.isHidden ? "" : (message.text ?? "")]
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        table.frame = view.bounds
        status.frame = CGRect(x: 20, y: view.bounds.height * 0.3, width: view.bounds.width - 40, height: 60)
        centreHighlightOnce()
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
        progress.flush()
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
                    apply(set)
                    failure.isHidden = true
                    refresh.endRefreshing()
                    delay = 1
                } catch {
                    guard !Task.isCancelled else { break }
                    refresh.endRefreshing()
                    if !loaded { show(failure: error) }
                    try? await Task.sleep(for: .seconds(delay))
                    delay = min(delay * 2, 30)
                }
            }
            self?.following = nil
        }
    }

    // Pulling down asks for the whole list again.
    private func reload() {
        following?.cancel()
        following = nil
        epoch = nil
        revision = nil
        follow()
    }

    private func apply(_ set: ChangeSet) {
        let anchor = topAnchor()
        if let all = set.videos {
            items = all
        } else {
            for change in set.changes ?? [] {
                if let removed = change.removed {
                    items.removeAll { $0.filename == removed.filename && $0.type == removed.type }
                } else if let item = change.item {
                    if let index = items.firstIndex(where: { $0.key == item.key }) { items[index] = item }
                    else { items.insert(item, at: items.insertionIndex(for: item)) }
                }
            }
        }
        let changed = set.videos != nil || !(set.changes ?? []).isEmpty || !loaded
        let moved = set.epoch != epoch || set.revision != revision
        epoch = set.epoch
        revision = set.revision
        loaded = true
        if changed {
            videos = items.map(api.describe)
            status.text = videos.isEmpty ? "No videos found." : nil
            status.isHidden = !videos.isEmpty
            table.reloadData()
            restore(anchor)
            centreHighlightOnce()
            viewer?.updateList(videos)
        }
        if changed || moved { cacheWriter.save(json: ListCache(provider: provider, epoch: set.epoch, revision: set.revision, videos: items)) }
    }

    // The first visible row and its place on screen, kept across a reload.
    private func topAnchor() -> (key: String, offset: CGFloat)? {
        guard centred, let first = table.indexPathsForVisibleRows?.first, videos.indices.contains(first.row) else { return nil }
        return (videos[first.row].key, table.rectForRow(at: first).minY - table.contentOffset.y)
    }

    private func restore(_ anchor: (key: String, offset: CGFloat)?) {
        guard let anchor, let row = videos.firstIndex(where: { $0.key == anchor.key }) else { return }
        table.layoutIfNeeded()
        table.contentOffset.y = table.rectForRow(at: IndexPath(row: row, section: 0)).minY - anchor.offset
    }

    private func centreHighlightOnce() {
        guard !centred, loaded, view.bounds.height > 0 else { return }
        centred = true
        guard let highlight, let row = videos.firstIndex(where: { $0.filename == highlight }) else { return }
        table.layoutIfNeeded()
        table.scrollToRow(at: IndexPath(row: row, section: 0), at: .middle, animated: false)
    }

    private func buildFailure() {
        message.numberOfLines = 0
        message.textAlignment = .center
        message.textColor = .lightGray
        let retry = UIButton(type: .system)
        retry.setTitle("Retry", for: .normal)
        retry.addAction(UIAction { [weak self] _ in self?.reload() }, for: .touchUpInside)
        failure.axis = .vertical
        failure.spacing = 16
        failure.alignment = .center
        failure.addArrangedSubview(message)
        failure.addArrangedSubview(retry)
        failure.isHidden = true
        failure.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(failure)
        NSLayoutConstraint.activate([
            failure.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failure.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            failure.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
        ])
    }

    private func show(failure error: Error) {
        message.text = "Can't reach your PC.\n\(error.localizedDescription)"
        failure.isHidden = false
        status.isHidden = true
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
            if self.highlight == nil, let filename = values["video-highlight:\(provider)"] as? String {
                self.highlight(filename, reveal: false)
                self.centred = false
                self.centreHighlightOnce()
            }
            try? DurableFile.write(Data(), to: marker)
        }
    }

    // MARK: rows

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { videos.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath) as! VideoRowCell
        let video = videos[indexPath.row]
        cell.show(video, highlighted: video.filename == highlight)
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        openViewer(at: indexPath.row)
    }

    // MARK: viewer

    private func openViewer(at index: Int) {
        guard videos.indices.contains(index) else { return }
        if let viewer, viewer.shows(videos[index]) { viewer.updateList(videos); return }
        showViewer(videos: videos, index: index)
    }

    // A killed app reopens its viewer; the list catches up underneath.
    private func restoreViewer() {
        guard let saved = ViewerCheckpoint.load(directory) else { return }
        showViewer(videos: saved.videos, index: saved.videos.firstIndex { $0.key == saved.current } ?? 0)
    }

    private func showViewer(videos: [ViewerVideo], index: Int) {
        viewer?.close()
        let controller = ViewerController(provider: provider, videos: videos, index: index, host: self,
                                          media: media, progress: progress, checkpoint: checkpoint)
        controller.onClose = { [weak self, weak controller] in
            guard let self, let controller else { return }
            controller.willMove(toParent: nil)
            controller.view.removeFromSuperview()
            controller.removeFromParent()
            if viewer === controller { viewer = nil }
            setNeedsStatusBarAppearanceUpdate()
        }
        addChild(controller)
        controller.view.frame = view.bounds
        controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(controller.view)
        controller.didMove(toParent: self)
        viewer = controller
        setNeedsStatusBarAppearanceUpdate()
    }

    // MARK: ViewerHost

    // Local recordings always have their source; asked anyway, it is the PC's playlist.
    func resolve(_ video: ViewerVideo) async throws -> MediaSource {
        if let media = video.media { return media }
        return MediaSource(url: api.playlist(video.filename), kind: "hls")
    }

    func related(_ video: ViewerVideo) async throws -> [ViewerVideo] { [] }
    func follow(_ video: ViewerVideo, _ follow: Bool) async throws {}
    func block(_ video: ViewerVideo) async throws {}
    func remove(_ filename: String) {}
    func append(_ videos: [ViewerVideo]) {}
    func login() {}

    func highlight(_ filename: String, reveal: Bool) {
        let previous = highlight
        highlight = filename
        stateWriter.save(json: State(highlight: filename))
        let rows = videos.indices.filter { [previous, filename].contains(videos[$0].filename) }.map { IndexPath(row: $0, section: 0) }
        table.reloadRows(at: rows.filter { table.indexPathsForVisibleRows?.contains($0) ?? false }, with: .none)
        guard reveal, let row = videos.firstIndex(where: { $0.filename == filename }) else { return }
        let path = IndexPath(row: row, section: 0)
        let rect = table.rectForRow(at: path)
        let visible = table.bounds.inset(by: table.adjustedContentInset)
        if !visible.contains(rect) { table.scrollToRow(at: path, at: .middle, animated: false) }
    }

    // A save, cut or return: the change feed brings the moved folder; the row follows at once.
    func changed(_ video: ViewerVideo) {
        guard let row = videos.firstIndex(where: { $0.filename == video.filename }) else { return }
        videos[row] = video
        table.reloadRows(at: [IndexPath(row: row, section: 0)], with: .none)
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

// A row as on the website: the name on one line (red while recording, orange when edited),
// below it the duration and an estimated size (bold above 350 MiB); the last viewed row bold
// on a darker background.
final class VideoRowCell: UITableViewCell {
    static let height: CGFloat = 52
    private let name = UILabel()
    private let duration = UILabel()
    private let size = UILabel()
    private let separator = UIView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .black
        let selected = UIView()
        selected.backgroundColor = UIColor(white: 0.165, alpha: 1)
        selectedBackgroundView = selected
        name.lineBreakMode = .byTruncatingTail
        for label in [duration, size] {
            label.textColor = UIColor(white: 0.67, alpha: 1)
            label.font = Self.mono
        }
        size.textAlignment = .right
        separator.backgroundColor = UIColor(white: 0.2, alpha: 1)
        [name, duration, size, separator].forEach(contentView.addSubview)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    private static let mono = UIFont(name: "Courier New", size: 13) ?? .monospacedSystemFont(ofSize: 13, weight: .regular)
    private static let monoBold = UIFont(name: "CourierNewPS-BoldMT", size: 13) ?? .monospacedSystemFont(ofSize: 13, weight: .bold)

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width
        name.frame = CGRect(x: 15, y: 8, width: width - 30, height: 21)
        duration.frame = CGRect(x: 15, y: contentView.bounds.height - 4 - 16, width: (width - 30) / 2, height: 16)
        size.frame = CGRect(x: width / 2, y: contentView.bounds.height - 4 - 16, width: width / 2 - 15, height: 16)
        separator.frame = CGRect(x: 0, y: contentView.bounds.height - 1, width: width, height: 1)
    }

    func show(_ video: ViewerVideo, highlighted: Bool) {
        name.text = video.name
        name.font = highlighted ? .boldSystemFont(ofSize: 16) : .systemFont(ofSize: 16)
        name.textColor = video.isLive ? UIColor(red: 1, green: 0.42, blue: 0.42, alpha: 1)
            : video.edited ? UIColor(red: 0.94, green: 0.63, blue: 0.31, alpha: 1) : .white
        backgroundColor = highlighted ? UIColor(white: 0.055, alpha: 1) : .black
        let seconds = (video.raw["duration"] as? NSNumber)?.doubleValue ?? 0
        duration.text = Self.duration(seconds)
        let bytes = seconds * 2_300_000 / 8
        size.text = bytes > 0 ? String(format: "%.1f MiB", bytes / 1_048_576) : "-- MiB"
        let large = bytes > 350 * 1_048_576
        size.textColor = large ? UIColor(white: 0.88, alpha: 1) : UIColor(white: 0.67, alpha: 1)
        size.font = large ? Self.monoBold : Self.mono
    }

    static func duration(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "--:--" }
        let total = Int(seconds), hours = total / 3600, minutes = (total % 3600) / 60, rest = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%02d:%02d", minutes, rest)
    }
}
