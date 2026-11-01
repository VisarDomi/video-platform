import UIKit
import WebKit
import Network
import KitCore
import KitNet
import CryptoKit

// Tango's live list, native: followed streams first, then recommendations, as the website
// listed them. It opens with the last list (kept on the phone) and asks Tango for a new one
// behind it; the order then stays while browsing (pull down, or return after half an hour,
// for a new list). Co-streamers found while watching join the end. The session is the app's
// own (TangoSession); signing in stays the Safari handoff (Tango Login), or a new session
// from a PC set up for Tango.
@MainActor
final class TangoListController: VideoListController {
    private let jar: CookieJar
    private let session: TangoSession
    private let pc: TangoPCLogin?
    private let hasAutomaticRecovery: Bool
    private let keptWriter: BackgroundWriter
    private var streams: [TangoStream] = []
    private var loading: Task<Void, Never>?
    private var lastSuccess: Date?
    private var lastError: String?
    private var requestGeneration = 0
    private var retry: Task<Void, Never>?
    private var retryDelay: Double = 1
    private var active = true
    private let network = NWPathMonitor()
    private var networkSignature: String?
    private var loginView: TangoLoginView?
    // Co-streamers as found (with their names), for append; and the lookup of those still unnamed.
    private var found: [String: TangoStream] = [:]
    private var naming: Task<Void, Never>?

    init(directory supplied: URL? = nil, configuration: URLSessionConfiguration? = nil,
         loginRecovery: TangoSession.LoginRecovery? = nil, pcLoginEnabled: Bool = true) {
        let directory = supplied ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/LocalVideos")
        try? FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.protectionKey:FileProtectionType.completeUntilFirstUserAuthentication])
        try? FileManager.default.setAttributes([.protectionKey:FileProtectionType.completeUntilFirstUserAuthentication],ofItemAtPath:directory.path)
        jar = CookieJar(file: directory.appendingPathComponent("cookies.json"))
        let computer = pcLoginEnabled ? TangoPCLogin(directory: directory) : nil
        pc = computer
        hasAutomaticRecovery = computer != nil || loginRecovery != nil
        var recovery = loginRecovery
        if recovery == nil, let computer {
            recovery = { rt in try await computer.newSession(refreshToken:rt) }
        }
        var accepted: (@Sendable () async -> Void)?
        if let computer { accepted = { await computer.acceptedSession() } }
        session = TangoSession(jar: jar, diagnosticURL: directory.appendingPathComponent("tango-network.json"), configuration: configuration,
                               loginRecovery: recovery, recoveryAccepted: accepted, beginRenewal:{await TangoRenewalLifetime.begin()})
        keptWriter = BackgroundWriter(url: directory.appendingPathComponent("tango-list.json"), label: "tango-list")
        super.init(viewerProvider: "tango-live", directory: directory, media: ViewerMedia(tango: session))
        if let kept = try? DurableFile.readJSON([TangoStream].self, from: keptWriter.url) {
            streams = kept
            publish()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
    deinit { network.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        DebugState.shared.register("tango") { [weak self] in
            guard let self else { return [:] }
            return ["streams": streams.count, "signedIn": session.signedIn, "login": loginView != nil, "loading": loading != nil,
                    "lastError": lastError ?? "", "lastSuccess": lastSuccess?.timeIntervalSince1970 ?? 0,
                    "retryPending": retry != nil, "network": networkSignature ?? "", "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""]
        }
        // The sign-in screen as last shown comes back in the first frame; the session (and the
        // PC) are asked again behind it.
        if !hasAutomaticRecovery, let shown = try? DurableFile.readJSON(LoginShown.self, from: loginFile) { showLogin(shown.reason, pc: shown.pc) }
        migrateCookies { [weak self] in self?.signIn(); self?.nameCoStreamers() }
        network.pathUpdateHandler = { [weak self] path in
            let signature = "\(path.status):" + path.availableInterfaces.map(\.name).sorted().joined(separator: ",")
            let reachable = path.status == .satisfied
            Task { @MainActor in self?.networkChanged(signature: signature, reachable: reachable) }
        }
        network.start(queue: DispatchQueue(label: "TangoList.network"))
        // Paired-device protocol verification only: normal renewal operations,
        // with sanitized receipts and the user's existing explorer state.
        if ProcessInfo.processInfo.arguments.contains("-check-tango-auth") {
            Task{[weak self] in await self?.checkAuthentication()}
        }
    }

    private func checkAuthentication() async {
        func fingerprint(_ value:String?)->String{value.map{SHA256.hash(data:Data($0.utf8)).prefix(8).map{String(format:"%02x",$0)}.joined()} ?? ""}
        let file=directory.appendingPathComponent("tango-auth-check.json")
        var steps:[[String:Any]]=[]
        do{
            for index in 0..<3 {
                let before=Tango.credential("Tango-RT",in:jar)?.value
                try await session.refresh()
                let after=Tango.credential("Tango-RT",in:jar)?.value
                let counts=await session.renewalCounts()
                steps.append(["step":index,"refreshChanged":before != after,"refreshHash":fingerprint(after),
                    "nativeRenewals":counts["nativeRenewals"] ?? 0,"initialSetups":counts["initialSetups"] ?? 0,
                    "accessExpiresIn":Tango.credential("Tango-ST",in:jar).map{Tango.expiration($0).timeIntervalSinceNow} ?? -1,
                    "deviceContext":jar.all.filter{["Tango-DI","Tango-DeviceId","Tango-SD"].contains($0.name)}.map(\.name)])
                try DurableFile.write(JSONSerialization.data(withJSONObject:["done":false,"steps":steps]),to:file)
                try await Task.sleep(for:.seconds(1))
            }
            let data=try JSONSerialization.data(withJSONObject:["done":true,"success":true,"steps":steps])
            try DurableFile.write(data,to:file)
        }catch{
            let data=try? JSONSerialization.data(withJSONObject:["done":true,"success":false,"steps":steps,"error":error.localizedDescription])
            if let data{try? DurableFile.write(data,to:file)}
        }
    }

    // MARK: app lifecycle (from SceneDelegate)

    func resumed(afterBackground: Bool) {
        active = true
        // Back from Safari's import: the inbox decides.
        if loginView != nil { signIn(); return }
        if lastError != nil || (lastSuccess.map({ Date().timeIntervalSince($0) > 1800 }) ?? true) { reload() }
    }

    func paused() {
        active = false
        requestGeneration += 1
        loading?.cancel(); loading = nil
        retry?.cancel(); retry = nil
        refresh.endRefreshing()
        flushState()
        jar.flush()
        keptWriter.flush()
    }

    // A confirmed Safari import moves in; then the list, or the login screen. A sign-in screen
    // already showing stays until the session has worked (a token Tango then rejects would
    // otherwise hide it for a second and bring it back).
    private func signIn() {
        _ = takeInbox()
        if session.signedIn { reload() } else { showLogin(nil) }
    }

    // MARK: the list

    override func reload() {
        retryDelay = 1
        Task { [weak self] in
            guard let self else { return }
            await session.retryAfterConnectionChange()
            loadList()
        }
    }

    func networkChanged(signature: String, reachable: Bool) {
        let changed = networkSignature != nil && networkSignature != signature
        networkSignature = signature
        if active, reachable, session.signedIn, changed || (lastError != nil && loading == nil) { reload() }
    }

    private func loadList() {
        guard session.signedIn else { refresh.endRefreshing(); showLogin(nil); return }
        guard active else { return }
        retry?.cancel(); retry = nil
        loading?.cancel()
        requestGeneration += 1
        let generation = requestGeneration
        loading = Task { [weak self] in
            guard let self else { return }
            defer {
                if generation == requestGeneration { refresh.endRefreshing(); loading = nil }
            }
            do {
                let fresh = try await session.live()
                guard !Task.isCancelled, generation == requestGeneration else { return }
                lastSuccess = Date()
                lastError = nil
                retryDelay = 1
                streams = fresh
                keptWriter.save(json: streams)
                publish()
                hideFailure()
                hideLogin()
            } catch TangoError.loginRequired {
                guard !Task.isCancelled, generation == requestGeneration else { return }
                lastError = TangoError.loginRequired.localizedDescription
                if hasAutomaticRecovery {hideLogin();if streams.isEmpty {showFailure("Restoring Tango’s saved login…")}}
                else {showLogin("Tango login is required.")}
            } catch TangoError.verificationRequired {
                guard !Task.isCancelled, generation == requestGeneration else { return }
                lastError = TangoError.verificationRequired.localizedDescription
                if hasAutomaticRecovery {
                    if !Tango.deviceContextComplete(jar.all){showLogin("Tango’s updated API needs the complete sign-in context once.")}
                    else {hideLogin();if streams.isEmpty {showFailure("Restoring Tango’s saved login…")}}
                } else {showLogin(lastError)}
                // The PC can return without the phone's NWPath changing. The
                // session cooldown and durable broker request prevent replays.
                let delay=hasAutomaticRecovery ? 5.0 : 120.0
                retry = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(delay))
                    guard !Task.isCancelled else { return }
                    self?.loadList()
                }
            } catch {
                guard !Task.isCancelled, generation == requestGeneration else { return }
                lastError = error.localizedDescription
                if !Task.isCancelled, loginView != nil { showLogin("Can't reach Tango to check the login.\n\(error.localizedDescription)") }
                else if !Task.isCancelled, streams.isEmpty { showFailure("Can't reach Tango.\n\(error.localizedDescription)") }
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
        status.text = streams.isEmpty && loaded ? "No live streams are available." : nil
        status.isHidden = status.text == nil
    }

    // As the website described a stream to the viewer: its playlist, its streamer on the PC's
    // Tango download list.
    private func describe(_ stream: TangoStream) -> ViewerVideo {
        var raw: [String: Any] = [
            "filename": stream.streamerId, "provider": "tango-live", "type": "original", "duration": 0, "size": 0, "isLive": true,
            "title": stream.title, "pageUrl": "/stream/" + (stream.streamId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? stream.streamId),
            "following": stream.following, "local": false, "live": true, "displayWidth": 720.0, "displayHeight": 1280.0,
            "media": ["url": stream.masterListUrl, "kind": "hls"],
            "membership": ["lists": ["tango"], "identifier": stream.streamerId, "choose": false],
        ]
        if let parent = stream.parent { raw["parent"] = parent }
        return ViewerVideo(raw)!
    }

    private func stream(_ video: ViewerVideo) -> TangoStream? { streams.first { $0.streamerId == video.filename } }

    private func auth<T>(_ work: () async throws -> T) async throws -> T {
        do { return try await work() }
        catch TangoError.loginRequired { throw ViewerFailure.authentication("Tango login is required.") }
    }

    // MARK: ViewerHost

    override func resolve(_ video: ViewerVideo) async throws -> MediaSource {
        if let media = video.media { return media }
        guard let stream = stream(video), let url = URL(string: stream.masterListUrl) else { throw ViewerFailure.page("This stream has ended.") }
        return MediaSource(url: url, kind: "hls")
    }

    override func related(_ video: ViewerVideo) async throws -> [ViewerVideo] {
        guard let current = stream(video) else { return [] }
        let streams = try await auth { try await session.related(streamer: current.streamerId, streamId: current.streamId) }
        for stream in streams { found[stream.streamerId] = stream }
        return streams.map(describe)
    }

    override func follow(_ video: ViewerVideo, _ follow: Bool) async throws {
        try await auth { try await session.follow(video.filename, follow) }
        if let index = streams.firstIndex(where: { $0.streamerId == video.filename }) {
            streams[index].following = follow
            keptWriter.save(json: streams)
            replaceVideo(describe(streams[index]))
        }
    }

    override func block(_ video: ViewerVideo) async throws {
        try await auth { try await session.block(video.filename, following: video.following) }
    }

    // An ended or blocked stream leaves the list.
    override func remove(_ filename: String) {
        streams.removeAll { $0.streamerId == filename }
        keptWriter.save(json: streams)
        publish()
    }

    // Co-streamers join the end, once, named as found (a row's title is not a name: it starts
    // with the alias, or with the ID when there is none).
    override func append(_ videos: [ViewerVideo]) {
        let known = Set(streams.map(\.streamerId))
        let added = videos.compactMap { video -> TangoStream? in
            guard !known.contains(video.filename) else { return nil }
            if let stream = found[video.filename] { return stream }
            guard let media = video.media, let page = video.pageUrl else { return nil }
            return TangoStream(streamerId: video.filename, streamId: String(page.dropFirst("/stream/".count)).removingPercentEncoding ?? "",
                               masterListUrl: media.url.absoluteString, firstName: video.filename, alias: nil,
                               following: video.following, parent: video.parent)
        }
        guard !added.isEmpty else { return }
        streams += added
        keptWriter.save(json: streams)
        publish()
        nameCoStreamers()
    }

    // Co-streamers without an alias (the names' lookup is best effort; and those kept before
    // October 13, 2026, whose rows began with the ID) are looked up again: at once, then after
    // 10, 30 and 60 seconds, until all have one.
    private func nameCoStreamers() {
        guard naming == nil else { return }
        naming = Task { [weak self] in
            for delay in [0, 10, 30, 60] {
                if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
                guard let self, !Task.isCancelled else { return }
                let unnamed = streams.filter { $0.parent != nil && $0.alias == nil }
                guard !unnamed.isEmpty, session.signedIn else { break }
                let named = Dictionary(await session.named(unnamed).map { ($0.streamerId, $0) }, uniquingKeysWith: { $1 })
                var changed = false
                for index in streams.indices {
                    guard let fresh = named[streams[index].streamerId], streams[index].alias == nil,
                          fresh.alias != nil || fresh.firstName != streams[index].firstName else { continue }
                    streams[index].alias = fresh.alias
                    streams[index].firstName = fresh.firstName
                    changed = true
                }
                if changed {
                    keptWriter.save(json: streams)
                    publish()
                }
            }
            self?.naming = nil
        }
    }

    override func login() {
        if hasAutomaticRecovery {reload()} else {showLogin("Tango login is required.")}
    }

    // MARK: signing in

    private struct LoginShown: Codable {
        var reason: String?
        var pc: Bool
    }

    private var loginFile: URL { directory.appendingPathComponent("tango-login.json") }
    private var loginReason: String?

    private func showLogin(_ reason: String?, pc known: Bool? = nil) {
        loginReason = reason
        if loginView == nil {
            let view = TangoLoginView()
            view.onConfirm = { [weak self] in self?.confirmImport() }
            view.onPC = { [weak self] in self?.loginFromPC() }
            view.frame = self.view.bounds
            view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            self.view.addSubview(view)
            loginView = view
        }
        loginView?.show(reason: reason, pending: (try? LoginStore.load()) != nil)
        // The PC's button as last seen until the PC answers again.
        let lastPC = known ?? (try? DurableFile.readJSON(LoginShown.self, from: loginFile))?.pc ?? false
        loginView?.showPC(lastPC)
        try? DurableFile.writeJSON(LoginShown(reason: reason, pc: lastPC), to: loginFile)
        guard let pc else { return }
        Task { [weak self] in
            let available = await pc.available()
            guard let self, loginView != nil else { return }
            loginView?.showPC(available)
            try? DurableFile.writeJSON(LoginShown(reason: loginReason, pc: available), to: loginFile)
        }
    }

    private func hideLogin() {
        loginView?.removeFromSuperview()
        loginView = nil
        try? FileManager.default.removeItem(at: loginFile)
    }

    // Tango Login's Keychain inbox: an import waits until the user confirms Safari's copy was
    // deleted (so two browsers never hold one session); confirmed, its cookies move into the jar.
    @discardableResult
    private func takeInbox() -> Bool {
        guard let inbox = try? LoginStore.load() else { return false }
        guard inbox.handoffComplete == true else { showLogin(nil); return false }
        let accepted = Tango.storeLogin(inbox.cookies.compactMap { item in
            HTTPCookie(properties: [.name: item.name, .value: item.value, .domain: item.domain, .path: item.path,
                                    .secure: "TRUE", .expires: Date(timeIntervalSince1970: item.expirationDate), HTTPCookiePropertyKey("HttpOnly"): "TRUE"])
        }, in: jar)
        guard accepted else { showLogin("The imported credentials do not form a valid Tango session. Import a fresh login."); return false }
        try? LoginStore.delete()
        Log.app.notice("Tango login imported from Safari")
        return true
    }

    private func confirmImport() {
        do {
            guard var inbox = try LoginStore.load() else { loginView?.show(reason: "No Tango login was imported yet.", pending: false); return }
            inbox.handoffComplete = true
            try LoginStore.save(inbox)
            loginView?.working("Signing in to Tango…")
            signIn()
        } catch { loginView?.show(reason: error.localizedDescription, pending: true) }
    }

    // A new session from the PC (its own browser login, a profile made and dropped for this
    // phone): one refresh token per device, never the PC's.
    private func loginFromPC() {
        guard let pc else { return }
        loginView?.working("The PC is signing in to Tango…")
        Task { [weak self] in
            do {
                let cookies = try await pc.newSession()
                guard let self else { return }
                guard Tango.storeLogin(cookies, in: jar) else { throw TangoError.verificationRequired }
                pc.acceptedSession()
                signIn()
            } catch {
                self?.loginView?.show(reason: "The PC could not sign in: \(error.localizedDescription)", pending: (try? LoginStore.load()) != nil)
            }
        }
    }

    // The web version's session lived in WebKit's cookies (and a backup of the login cookies);
    // the first native launch takes the newest refresh token into the jar, once.
    private func migrateCookies(_ done: @escaping () -> Void) {
        let marker = directory.appendingPathComponent("tango-cookies-migrated")
        guard !FileManager.default.fileExists(atPath: marker.path) else { return done() }
        let onSite: (HTTPCookie) -> Bool = { $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).hasSuffix("tango.me") }
        let backup = (try? Data(contentsOf: directory.appendingPathComponent("login-cookies.plist")))
            .flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [[String: Any]] } ?? []
        let saved = backup.compactMap { item in HTTPCookie(properties: Dictionary(uniqueKeysWithValues: item.map { (HTTPCookiePropertyKey($0.key), $0.value) })) }
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }
            var newest: [String: HTTPCookie] = [:]
            for cookie in (saved + cookies).filter(onSite) {
                let key = cookie.name + "|" + cookie.domain + "|" + cookie.path
                // A rotated refresh token expires later than the one it replaced.
                if let held = newest[key], (held.expiresDate ?? .distantPast) >= (cookie.expiresDate ?? .distantPast) { continue }
                newest[key] = cookie
            }
            jar.set(Array(newest.values))
            jar.flush()
            try? DurableFile.write(Data(), to: marker)
            Log.app.notice("Moved \(newest.count) Tango cookies out of WebKit")
            done()
        }
    }
}

// The handoff steps, with the original wording, and the PC's shortcut when one answers.
@MainActor
final class TangoLoginView: UIView {
    var onConfirm: () -> Void = {}
    var onPC: () -> Void = {}
    private let label = UILabel()
    private let open = UIButton(type: .system)
    private let confirm = UIButton(type: .system)
    private let pc = UIButton(type: .system)
    private let stack = UIStackView()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        label.numberOfLines = 0
        label.textColor = .lightGray
        open.setTitle("Open Tango in Safari", for: .normal)
        open.addAction(UIAction { _ in UIApplication.shared.open(URL(string: "https://www.tango.me/")!) }, for: .touchUpInside)
        confirm.setTitle("Safari data cleared — continue", for: .normal)
        confirm.addAction(UIAction { [weak self] _ in self?.onConfirm() }, for: .touchUpInside)
        pc.setTitle("Log in from the PC", for: .normal)
        pc.isHidden = true
        pc.addAction(UIAction { [weak self] _ in self?.onPC() }, for: .touchUpInside)
        for view in [label, open, confirm, pc] as [UIView] { stack.addArrangedSubview(view) }
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    func show(reason: String?, pending: Bool) {
        label.text = (reason.map { $0 + "\n\n" } ?? "") + "Sign in with Google on Tango in Safari. Enable Tango Login and choose Import login into Tango. Close Tango tabs, then delete only Tango in Safari’s Website Data settings."
            + (pending ? "\n\nA login was imported: confirm once Safari's copy is deleted." : "")
        open.isEnabled = true
        confirm.isEnabled = true
        pc.isEnabled = true
    }

    func showPC(_ available: Bool) { pc.isHidden = !available }

    func working(_ text: String) {
        label.text = text
        open.isEnabled = false
        confirm.isEnabled = false
        pc.isEnabled = false
    }
}
