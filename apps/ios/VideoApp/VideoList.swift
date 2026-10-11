import UIKit
import KitCore

// A video list as the website showed it, native: rows of name, duration (and a site mark) and
// estimated size; the last viewed row highlighted; rows open the native viewer over the list.
// The list's place (its top row and offset) is written whenever scrolling settles, so a kill
// returns to the same rows; without one, the highlighted row is centred. Subclasses fill the
// list (the PC's change feed, Video Vault's sites) and answer the viewer's requests.
@MainActor
class VideoListController: UIViewController, UITableViewDataSource, UITableViewDelegate, ViewerHost {
    struct State: Codable {
        var highlight: String?
        var top: String?
        var offset: Double?
    }

    let viewerProvider: String
    let directory: URL
    let table = UITableView(frame: .zero, style: .plain)
    let refresh = UIRefreshControl()
    let status = UILabel()
    private let failure = UIStackView()
    private let message = UILabel()
    private let header = UIView()
    private(set) var videos: [ViewerVideo] = []
    private(set) var marks: [String: String] = [:]
    var bytesPerSecond = 2_300_000.0 / 8
    private(set) var highlight: String?
    private var savedTop: (key: String, offset: CGFloat)?
    private var positioned = false
    var loaded = false
    let media: ViewerMedia
    let progress: ProgressStore
    let checkpoint: CheckpointWriter
    private(set) var viewer: ViewerController?
    private let stateWriter: BackgroundWriter

    init(viewerProvider: String, directory: URL, media: ViewerMedia) {
        self.viewerProvider = viewerProvider
        self.directory = directory
        self.media = media
        progress = ProgressStore(directory: directory)
        checkpoint = CheckpointWriter(directory: directory)
        stateWriter = BackgroundWriter(url: directory.appendingPathComponent("list-state.json"), label: "list-state")
        let state = try? DurableFile.readJSON(State.self, from: stateWriter.url)
        highlight = state?.highlight
        if let top = state?.top, let offset = state?.offset { savedTop = (top, CGFloat(offset)) }
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    // Full screen, as the website's lists were.
    override var prefersStatusBarHidden: Bool { true }
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
        table.indicatorStyle = .white
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
        restoreViewer()
        DebugState.shared.register("list") { [weak self] in
            guard let self else { return [:] }
            return ["provider": viewerProvider, "rows": videos.count, "highlight": highlight ?? "", "viewer": viewer?.currentVideo?.filename ?? "",
                    "offset": table.contentOffset.y, "failure": failure.isHidden ? "" : (message.text ?? ""), "marks": marks.count,
                    "notices": header.subviews.count]
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        table.frame = view.bounds
        status.frame = CGRect(x: 20, y: view.bounds.height * 0.3, width: view.bounds.width - 40, height: 60)
        layoutHeader()
        positionOnce()
    }

    // Pull to refresh (and Retry).
    func reload() {}

    // MARK: contents

    // A new list: the rows on screen stay where they are.
    func setVideos(_ new: [ViewerVideo], marks: [String: String] = [:]) {
        let anchor = positioned ? topAnchor() : nil
        videos = new
        self.marks = marks
        loaded = true
        status.text = videos.isEmpty ? "No videos found." : nil
        status.isHidden = !videos.isEmpty || !failure.isHidden
        table.reloadData()
        if let anchor { restore(anchor) }
        positionOnce()
        viewer?.updateList(videos)
    }

    func replaceVideo(_ video: ViewerVideo) {
        guard let row = videos.firstIndex(where: { $0.filename == video.filename }) else { return }
        videos[row] = video
        table.reloadRows(at: [IndexPath(row: row, section: 0)], with: .none)
    }

    // Messages above the list; a message with an action is tappable.
    func setNotices(_ notices: [(text: String, action: (() -> Void)?)]) {
        header.subviews.forEach { $0.removeFromSuperview() }
        for notice in notices { header.addSubview(NoticeView(text: notice.text, action: notice.action)) }
        layoutHeader()
    }

    private func layoutHeader() {
        guard !header.subviews.isEmpty else {
            if table.tableHeaderView != nil { table.tableHeaderView = nil }
            return
        }
        let width = view.bounds.width
        var y: CGFloat = 0
        for notice in header.subviews {
            let height = notice.sizeThatFits(CGSize(width: width, height: 0)).height
            notice.frame = CGRect(x: 0, y: y, width: width, height: height)
            y += height + 1
        }
        if header.frame.size != CGSize(width: width, height: y) || table.tableHeaderView !== header {
            header.frame = CGRect(x: 0, y: 0, width: width, height: y)
            table.tableHeaderView = header
        }
    }

    // The first visible row and its place on screen.
    private func topAnchor() -> (key: String, offset: CGFloat)? {
        guard let first = table.indexPathsForVisibleRows?.first, videos.indices.contains(first.row) else { return nil }
        return (videos[first.row].key, table.rectForRow(at: first).minY - table.contentOffset.y)
    }

    private func restore(_ anchor: (key: String, offset: CGFloat)) {
        guard let row = videos.firstIndex(where: { $0.key == anchor.key }) else { return }
        table.layoutIfNeeded()
        let maxOffset = max(-table.adjustedContentInset.top, table.contentSize.height + table.adjustedContentInset.bottom - table.bounds.height)
        table.contentOffset.y = min(max(-table.adjustedContentInset.top, table.rectForRow(at: IndexPath(row: row, section: 0)).minY - anchor.offset), maxOffset)
    }

    // Once, after layout: the saved place, else the highlighted row centred.
    private func positionOnce() {
        guard !positioned, loaded, table.bounds.height > 0, !videos.isEmpty else { return }
        positioned = true
        if let savedTop, videos.contains(where: { $0.key == savedTop.key }) { restore(savedTop); return }
        guard let highlight, let row = videos.firstIndex(where: { $0.filename == highlight }) else { return }
        table.layoutIfNeeded()
        table.scrollToRow(at: IndexPath(row: row, section: 0), at: .middle, animated: false)
    }

    private func savePlace() {
        guard positioned else { return }
        savedTop = topAnchor()
        saveState()
    }

    private func saveState() {
        stateWriter.save(json: State(highlight: highlight, top: savedTop?.key, offset: savedTop.map { Double($0.offset) }))
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { if !decelerate { savePlace() } }
    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { savePlace() }

    func flushState() {
        stateWriter.flush()
        progress.flush()
    }

    // MARK: failure

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

    // A failure with nothing to show: the message and Retry.
    func showFailure(_ text: String) {
        message.text = text
        failure.isHidden = false
        status.isHidden = true
    }

    func hideFailure() { failure.isHidden = true }

    // MARK: rows

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { videos.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath) as! VideoRowCell
        let video = videos[indexPath.row]
        cell.show(video, highlighted: video.filename == highlight, mark: marks[video.filename], bytesPerSecond: bytesPerSecond)
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: false)
        savePlace()
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
        let controller = ViewerController(provider: viewerProvider, videos: videos, index: index, host: self,
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

    // MARK: ViewerHost (subclasses answer what their videos need)

    func resolve(_ video: ViewerVideo) async throws -> MediaSource {
        guard let media = video.media else { throw ViewerBridge.Failure.page("This video has no source.") }
        return media
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
        saveState()
        let rows = videos.indices.filter { [previous, filename].contains(videos[$0].filename) }.map { IndexPath(row: $0, section: 0) }
        table.reloadRows(at: rows.filter { table.indexPathsForVisibleRows?.contains($0) ?? false }, with: .none)
        guard reveal, let row = videos.firstIndex(where: { $0.filename == filename }) else { return }
        let path = IndexPath(row: row, section: 0)
        let rect = table.rectForRow(at: path)
        let visible = table.bounds.inset(by: table.adjustedContentInset)
        if !visible.contains(rect) { table.scrollToRow(at: path, at: .middle, animated: false) }
        savePlace()
    }

    func changed(_ video: ViewerVideo) { replaceVideo(video) }
}

// A message above a list (blue and tappable when it leads somewhere, amber otherwise).
final class NoticeView: UIControl {
    private let label = UILabel()
    private let action: (() -> Void)?

    init(text: String, action: (() -> Void)?) {
        self.action = action
        super.init(frame: .zero)
        backgroundColor = UIColor(white: 0.08, alpha: 1)
        label.text = text
        label.numberOfLines = 0
        label.font = .systemFont(ofSize: 14)
        label.textColor = action == nil ? UIColor(red: 0.98, green: 0.75, blue: 0.14, alpha: 1) : UIColor(red: 0.4, green: 0.67, blue: 1, alpha: 1)
        label.isUserInteractionEnabled = false
        addSubview(label)
        isEnabled = action != nil
        if action != nil { accessibilityTraits = .button }
        addAction(UIAction { [weak self] _ in self?.action?() }, for: .touchUpInside)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = bounds.insetBy(dx: 15, dy: 10)
    }

    override func sizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: label.sizeThatFits(CGSize(width: size.width - 30, height: .greatestFiniteMagnitude)).height + 20)
    }

    override var isHighlighted: Bool { didSet { alpha = isHighlighted ? 0.6 : 1 } }
}

// A row as on the website: the name on one line (red while recording or live, orange when
// edited), below it the duration (with the site mark, orange) and an estimated size (bold
// above 350 MiB); the last viewed row bold on a darker background.
final class VideoRowCell: UITableViewCell {
    static let height: CGFloat = 52
    private let name = UILabel()
    private let duration = UILabel()
    private let mark = UILabel()
    private let size = UILabel()
    private let separator = UIView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .black
        let selected = UIView()
        selected.backgroundColor = UIColor(white: 0.165, alpha: 1)
        selectedBackgroundView = selected
        name.lineBreakMode = .byTruncatingTail
        for label in [duration, size, mark] {
            label.textColor = UIColor(white: 0.67, alpha: 1)
            label.font = Self.mono
        }
        mark.textColor = UIColor(red: 0.94, green: 0.63, blue: 0.31, alpha: 1)
        size.textAlignment = .right
        separator.backgroundColor = UIColor(white: 0.2, alpha: 1)
        [name, duration, mark, size, separator].forEach(contentView.addSubview)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    private static let mono = UIFont(name: "Courier New", size: 13) ?? .monospacedSystemFont(ofSize: 13, weight: .regular)
    private static let monoBold = UIFont(name: "CourierNewPS-BoldMT", size: 13) ?? .monospacedSystemFont(ofSize: 13, weight: .bold)

    override func layoutSubviews() {
        super.layoutSubviews()
        let width = contentView.bounds.width, y = contentView.bounds.height - 4 - 16
        name.frame = CGRect(x: 15, y: 8, width: width - 30, height: 21)
        let durationWidth = ceil(duration.sizeThatFits(CGSize(width: width, height: 16)).width)
        duration.frame = CGRect(x: 15, y: y, width: durationWidth, height: 16)
        mark.frame = CGRect(x: 15 + durationWidth + 8, y: y, width: 60, height: 16)
        size.frame = CGRect(x: width / 2, y: y, width: width / 2 - 15, height: 16)
        separator.frame = CGRect(x: 0, y: contentView.bounds.height - 1, width: width, height: 1)
    }

    func show(_ video: ViewerVideo, highlighted: Bool, mark siteMark: String? = nil, bytesPerSecond: Double) {
        name.text = video.name
        name.font = highlighted ? .boldSystemFont(ofSize: 16) : .systemFont(ofSize: 16)
        name.textColor = video.isLive ? UIColor(red: 1, green: 0.42, blue: 0.42, alpha: 1)
            : video.edited ? UIColor(red: 0.94, green: 0.63, blue: 0.31, alpha: 1) : .white
        backgroundColor = highlighted ? UIColor(white: 0.055, alpha: 1) : .black
        mark.text = siteMark
        let seconds = (video.raw["duration"] as? NSNumber)?.doubleValue ?? 0
        if video.liveStream {
            duration.text = "LIVE"
            size.text = ""
        } else {
            duration.text = Self.duration(seconds)
            let bytes = seconds * bytesPerSecond
            size.text = bytes > 0 ? String(format: "%.1f MiB", bytes / 1_048_576) : "-- MiB"
            let large = bytes > 350 * 1_048_576
            size.textColor = large ? UIColor(white: 0.88, alpha: 1) : UIColor(white: 0.67, alpha: 1)
            size.font = large ? Self.monoBold : Self.mono
        }
        setNeedsLayout()
    }

    static func duration(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds > 0 else { return "--:--" }
        let total = Int(seconds), hours = total / 3600, minutes = (total % 3600) / 60, rest = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%02d:%02d", minutes, rest)
    }
}
