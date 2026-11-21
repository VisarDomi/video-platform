import UIKit
import Network
import KitCore
import KitNet

// A live site's list, native (Info.plist NativeList): the followed accounts that are live now,
// in the site's order. It opens with the last list (kept on the phone) and asks the site for a
// new one behind it; the order then stays while browsing (pull down, or come back after half an
// hour, for a new list). Each stream plays from the site with its short-lived tokens (LiveSession);
// "+" puts its account on the PC's download list for the site (ViewerPC, the membership below).
// The session is the phone's own; the first one comes from the PC (LivePCLogin).
@MainActor
final class LiveListController: VideoListController {
    private let site: String
    private let session: LiveSession
    private let pc: LivePCLogin?
    private let keptWriter: BackgroundWriter
    private var streams: [LiveStream] = []
    private var loading: Task<Void, Never>?
    private var listOperation = OperationState()
    private var retry: Task<Void, Never>?
    private var retryDelay: Double = 1
    private var lastSuccess: Date?
    private var lastError: String?
    private var active = true
    private let network = NWPathMonitor()
    private var networkSignature: String?
    private let signIn = UIButton(type: .system)

    // `site` is the site's ID (the provider, its PC routes and list), `base` where the phone
    // reaches the site (Info.plist LiveSite).
    init(site: String, base: URL, directory supplied: URL? = nil, configuration: URLSessionConfiguration? = nil, pcLogin: Bool = true) {
        let directory = supplied ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/LiveVideos")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                 attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        self.site = site
        let jar = CookieJar(file: directory.appendingPathComponent("cookies.json"))
        let computer = pcLogin ? LivePCLogin(site: site, host: base.host ?? "localhost", directory: directory) : nil
        pc = computer
        var recovery: LiveSession.LoginRecovery?
        if let computer { recovery = { try await computer.newSession() } }
        session = LiveSession(site: base, jar: jar, configuration: configuration, loginRecovery: recovery)
        keptWriter = BackgroundWriter(url: directory.appendingPathComponent("\(site)-list.json"), label: "\(site)-list")
        super.init(viewerProvider: site, directory: directory, media: ViewerMedia(live: session))
        if let kept = try? DurableFile.readJSON([LiveStream].self, from: keptWriter.url) {
            streams = kept
            publish()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
    deinit { network.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        DebugState.shared.register("live") { [weak self] in
            guard let self else { return [:] }
            return ["site": site, "streams": streams.count, "signedIn": session.signedIn, "signInShown": !signIn.isHidden,
                    "loading": loading != nil, "lastError": lastError ?? "", "lastSuccess": lastSuccess?.timeIntervalSince1970 ?? 0,
                    "retryPending": retry != nil]
        }
        signIn.setTitle("Sign in from the PC", for: .normal)
        signIn.titleLabel?.font = .boldSystemFont(ofSize: 18)
        signIn.isHidden = true
        signIn.translatesAutoresizingMaskIntoConstraints = false
        signIn.addAction(UIAction { [weak self] _ in self?.signInFromPC() }, for: .touchUpInside)
        view.addSubview(signIn)
        NSLayoutConstraint.activate([signIn.centerXAnchor.constraint(equalTo: view.centerXAnchor),
                                     signIn.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: 60)])
        network.pathUpdateHandler = { [weak self] path in
            let signature = "\(path.status):" + path.availableInterfaces.map(\.name).sorted().joined(separator: ",")
            let reachable = path.status == .satisfied
            Task { @MainActor in self?.networkChanged(signature: signature, reachable: reachable) }
        }
        network.start(queue: DispatchQueue(label: "LiveList.network"))
        loadList()
    }

    // MARK: app lifecycle (from SceneDelegate)

    func resumed(afterBackground: Bool) {
        active = true
        if lastError != nil || (lastSuccess.map { Date().timeIntervalSince($0) > 1800 } ?? true) { reload() }
    }

    func paused() {
        active = false
        listOperation.cancel()
        loading?.cancel(); loading = nil
        retry?.cancel(); retry = nil
        refresh.endRefreshing()
        session.jar.flush()
    }

    override func flushCachedList() { keptWriter.flush() }

    // MARK: the list

    override func reload() {
        retryDelay = 1
        Task { [weak self] in
            guard let self else { return }
            await session.retryAfterConnectionChange()
            loadList()
        }
    }

    private func networkChanged(signature: String, reachable: Bool) {
        let changed = networkSignature != nil && networkSignature != signature
        networkSignature = signature
        if active, reachable, changed || (lastError != nil && loading == nil) { reload() }
    }

    private func signInFromPC() {
        signIn.isHidden = true
        showFailure("Signing in from the PC…")
        reload()
    }

    private func loadList() {
        guard active else { return }
        guard session.signedIn else {
            refresh.endRefreshing()
            showFailure(pc == nil ? "This app has no way to sign in: build it with the PC's phone key." : "The site's login is required.")
            signIn.isHidden = pc == nil
            return
        }
        retry?.cancel(); retry = nil
        loading?.cancel()
        let operation = listOperation.begin()
        loading = Task { [weak self] in
            guard let self else { return }
            defer { if listOperation.finish(operation) { refresh.endRefreshing(); loading = nil } }
            do {
                let fresh = try await session.live()
                guard !Task.isCancelled, listOperation.owns(operation) else { return }
                pc?.accepted()
                lastSuccess = Date()
                lastError = nil
                retryDelay = 1
                streams = fresh
                keptWriter.save(json: streams)
                publish()
                hideFailure()
                signIn.isHidden = true
            } catch {
                guard !Task.isCancelled, listOperation.owns(operation) else { return }
                lastError = error.localizedDescription
                if case LiveError.loginRequired = error {
                    showFailure("The site's login is required.")
                    signIn.isHidden = pc == nil
                    return
                }
                if streams.isEmpty { showFailure("Can't reach the site.\n\(error.localizedDescription)") }
                let delay = retryDelay
                retryDelay = min(30, retryDelay * 2)
                retry = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(delay))
                    guard !Task.isCancelled else { return }
                    self?.loadList()
                }
            }
        }
    }

    private func publish() {
        setVideos(streams.map(describe))
        status.text = streams.isEmpty && loaded ? "Nobody you follow is live." : nil
        status.isHidden = status.text == nil
    }

    // A stream as the viewer takes it: its playlist from the site, its account on the PC's
    // download list for the site.
    private func describe(_ stream: LiveStream) -> ViewerVideo {
        ViewerVideo([
            "filename": stream.accountId, "provider": site, "type": "original", "duration": 0, "size": 0, "isLive": true,
            "title": stream.title, "following": stream.following, "local": false, "live": true,
            "displayWidth": 1280.0, "displayHeight": 720.0, "blockable": false,
            "media": ["url": stream.masterUrl, "kind": "hls"],
            "membership": ["lists": [site], "identifier": stream.accountId, "choose": false],
        ])!
    }

    private func stream(_ video: ViewerVideo) -> LiveStream? { streams.first { $0.accountId == video.filename } }

    // MARK: ViewerHost

    override func resolve(_ video: ViewerVideo) async throws -> MediaSource {
        if let media = video.media { return media }
        guard let stream = stream(video), let url = URL(string: stream.masterUrl) else { throw ViewerFailure.page("This stream has ended.") }
        return MediaSource(url: url, kind: "hls")
    }

    override func follow(_ video: ViewerVideo, _ follow: Bool) async throws {
        // The site can only follow; unfollowing is the site's own page.
        guard follow else { throw ViewerFailure.page("Unfollow on the site itself.") }
        do { try await session.follow(video.filename) }
        catch LiveError.loginRequired { throw ViewerFailure.authentication("The site's login is required.") }
        if let index = streams.firstIndex(where: { $0.accountId == video.filename }) {
            streams[index].following = true
            keptWriter.save(json: streams)
            replaceVideo(describe(streams[index]))
        }
    }

    // An ended stream leaves the list.
    override func remove(_ filename: String) {
        streams.removeAll { $0.accountId == filename }
        keptWriter.save(json: streams)
        publish()
    }
}
