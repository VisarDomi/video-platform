#if targetEnvironment(simulator)
import UIKit
import KitCore
import KitTestHooks

// Exercises the actual shared list/navigation/restoration with static player
// surfaces. No provider requests, AVPlayerItems, video decoding or product data.
@MainActor
final class ListNavigationChecks: VideoListController {
    private let sourceProvider: String
    private var fixtureRows: [ViewerVideo] = []
    private var lastOpenMs = 0.0
    private var lastCloseMs = 0.0

    init() {
        let arguments = ProcessInfo.processInfo.arguments
        let provider = arguments.firstIndex(of: "-navigation-provider").flatMap { arguments.indices.contains($0 + 1) ? arguments[$0 + 1] : nil } ?? "bunkr"
        sourceProvider = provider
        let directory = URL.documentsDirectory.appendingPathComponent("navigation-check/" + provider)
        if arguments.contains("-reset-navigation-check") { try? FileManager.default.removeItem(at: directory) }
        super.init(viewerProvider: provider, directory: directory, media: ViewerMedia())
        let picture = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 18)).image { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(x: 0, y: 0, width: 32, height: 18))
        }
        configureTestViewer = { $0.configureNavigationCheck(image: picture) }
        fixtureRows = (0..<120).map { index in
            ViewerVideo(["filename": String(format: "Video %03d.mp4", index), "provider": provider,
                         "local": ["sc", "fc2", "tango"].contains(provider), "live": provider == "tango-live",
                         "duration": 400.0, "displayWidth": 1920.0, "displayHeight": 1080.0])!
        }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override func viewDidLoad() {
        super.viewDidLoad()
        setVideos(fixtureRows)
        TestHooks.shared.register("navigation-state") { [weak self] _ in self?.state() ?? [:] }
        TestHooks.shared.register("navigation-list-scroll") { [weak self] query in
            guard let self, viewer == nil else { return [:] }
            table.contentOffset.y = CGFloat(Double(query["offset"] ?? "0") ?? 0)
            table.layoutIfNeeded()
            if query["end"] != "0" { scrollViewDidEndDragging(table, willDecelerate: false) }
            return state()
        }
        TestHooks.shared.register("navigation-open") { [weak self] query in
            guard let self, let row = Int(query["row"] ?? ""), videos.indices.contains(row) else { return [:] }
            table.scrollToRow(at: IndexPath(row: row, section: 0), at: .middle, animated: false)
            table.layoutIfNeeded()
            let started = CACurrentMediaTime()
            tableView(table, didSelectRowAt: IndexPath(row: row, section: 0))
            lastOpenMs = (CACurrentMediaTime() - started) * 1000
            return state()
        }
        TestHooks.shared.register("navigation-back") { [weak self] _ in
            guard let self else { return [:] }
            let started = CACurrentMediaTime()
            viewer?.close()
            lastCloseMs = (CACurrentMediaTime() - started) * 1000
            return state()
        }
        TestHooks.shared.register("navigation-forward") { [weak self] _ in
            self?.goForward(); return self?.state() ?? [:]
        }
        TestHooks.shared.register("navigation-edit-start") { [weak self] _ in
            self?.viewer?.captureMutationCheck(); return self?.state() ?? [:]
        }
        TestHooks.shared.register("navigation-edit-finish") { [weak self] query in
            self?.viewer?.completeMutationCheck(type: query["type"] ?? "edited"); return self?.state() ?? [:]
        }
        TestHooks.shared.register("navigation-edit-arrival") { [weak self] query in
            guard let self, let current = viewer?.currentVideo else { return [:] }
            fixtureRows = fixtureRows.map { $0.sameRecording(current) ? $0.setting("type", query["type"] ?? "edited") : $0 }
            setVideos(fixtureRows)
            return state()
        }
        TestHooks.shared.register("feed-scroll") { [weak self] query in
            _ = self?.viewer?.checkFeedScroll(delta: CGFloat(Double(query["delta"] ?? "0") ?? 0), end: query["end"] != "0")
            return self?.state() ?? [:]
        }
        TestHooks.shared.register("navigation-zoom") { [weak self] query in
            _ = self?.viewer?.checkViewportZoom(scale: query["scale"].flatMap(Double.init), x: query["x"].flatMap(Double.init), y: query["y"].flatMap(Double.init))
            return self?.state() ?? [:]
        }
        TestHooks.shared.register("navigation-flush") { [weak self] _ in
            self?.flushState(); return self?.state() ?? [:]
        }
        TestHooks.shared.register("navigation-arrival") { [weak self] _ in
            guard let self else { return [:] }
            let new = ViewerVideo(["filename": "New completed.webm", "provider": sourceProvider,
                                   "displayWidth": 1920.0, "displayHeight": 1080.0, "duration": 400.0])!
            if !fixtureRows.contains(where: { $0.same(new) }) { fixtureRows.insert(new, at: 0) }
            setVideos(fixtureRows)
            return state()
        }
    }

    override func changed(_ video: ViewerVideo) {
        fixtureRows = fixtureRows.map { $0.sameRecording(video) ? video : $0 }
        setVideos(fixtureRows)
    }

    private func state() -> [String: Any] {
        let row = table.indexPathsForVisibleRows?.first?.row
        return ["provider": sourceProvider, "rows": videos.count, "highlight": highlight ?? "",
                "viewer": viewer?.currentVideo?.filename ?? "", "offset": table.contentOffset.y,
                "firstRow": row.map { videos[$0].filename } ?? "", "openMs": lastOpenMs, "closeMs": lastCloseMs,
                "viewerState": viewer?.zoomCheckState ?? [:]]
    }
}
#endif
