import UIKit
import WebKit
import KitCore
import KitNet

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
    private let keptWriter: BackgroundWriter
    private var streams: [TangoStream] = []
    private var loading: Task<Void, Never>?
    private var lastLoad: Date?
    private var loginView: TangoLoginView?

    init() {
        let directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/LocalVideos")
        jar = CookieJar(file: directory.appendingPathComponent("cookies.json"))
        session = TangoSession(jar: jar)
        pc = TangoPCLogin()
        keptWriter = BackgroundWriter(url: directory.appendingPathComponent("tango-list.json"), label: "tango-list")
        super.init(viewerProvider: "tango-live", directory: directory, media: ViewerMedia(tango: session))
        if let kept = try? DurableFile.readJSON([TangoStream].self, from: keptWriter.url) {
            streams = kept
            publish()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override func viewDidLoad() {
        super.viewDidLoad()
        DebugState.shared.register("tango") { [weak self] in
            guard let self else { return [:] }
            return ["streams": streams.count, "signedIn": session.signedIn, "login": loginView != nil, "loading": loading != nil]
        }
        migrateCookies { [weak self] in self?.signIn() }
    }

    // MARK: app lifecycle (from SceneDelegate)

    func resumed(afterBackground: Bool) {
        // Back from Safari's import: the inbox decides.
        if loginView != nil { signIn(); return }
        if lastLoad.map({ Date().timeIntervalSince($0) > 1800 }) ?? true { reload() }
    }

    func paused() {
        flushState()
        jar.flush()
        keptWriter.flush()
    }

    // A confirmed Safari import moves in; then the list, or the login screen.
    private func signIn() {
        _ = takeInbox()
        if session.signedIn { hideLogin(); reload() } else { showLogin(nil) }
    }

    // MARK: the list

    override func reload() {
        guard session.signedIn else { refresh.endRefreshing(); showLogin(nil); return }
        loading?.cancel()
        lastLoad = Date()
        loading = Task { [weak self] in
            guard let self else { return }
            do {
                let fresh = try await session.live()
                guard !Task.isCancelled else { return }
                streams = fresh
                keptWriter.save(json: streams)
                publish()
                hideFailure()
            } catch TangoError.loginRequired {
                showLogin("Tango signed out.")
            } catch {
                if !Task.isCancelled, streams.isEmpty { showFailure("Can't reach Tango.\n\(error.localizedDescription)") }
            }
            refresh.endRefreshing()
            loading = nil
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
            "following": stream.following, "local": false, "live": true,
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
        let found = try await auth { try await session.related(streamer: current.streamerId, streamId: current.streamId) }
        return found.map(describe)
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

    // Co-streamers join the end, once.
    override func append(_ videos: [ViewerVideo]) {
        let known = Set(streams.map(\.streamerId))
        let added = videos.compactMap { video -> TangoStream? in
            guard !known.contains(video.filename), let media = video.media, let page = video.pageUrl else { return nil }
            return TangoStream(streamerId: video.filename, streamId: String(page.dropFirst("/stream/".count)).removingPercentEncoding ?? "",
                               masterListUrl: media.url.absoluteString, firstName: video.title ?? video.filename, alias: nil,
                               following: video.following, parent: video.parent)
        }
        guard !added.isEmpty else { return }
        streams += added
        keptWriter.save(json: streams)
        publish()
    }

    override func login() { showLogin("Tango signed out.") }

    // MARK: signing in

    private func showLogin(_ reason: String?) {
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
        guard let pc else { return }
        Task { [weak self] in
            let available = await pc.available()
            self?.loginView?.showPC(available)
        }
    }

    private func hideLogin() {
        loginView?.removeFromSuperview()
        loginView = nil
    }

    // Tango Login's Keychain inbox: an import waits until the user confirms Safari's copy was
    // deleted (so two browsers never hold one session); confirmed, its cookies move into the jar.
    @discardableResult
    private func takeInbox() -> Bool {
        guard let inbox = try? LoginStore.load() else { return false }
        guard inbox.handoffComplete == true else { showLogin(nil); return false }
        jar.set(inbox.cookies.compactMap { item in
            HTTPCookie(properties: [.name: item.name, .value: item.value, .domain: item.domain, .path: item.path,
                                    .secure: "TRUE", .expires: Date(timeIntervalSince1970: item.expirationDate), HTTPCookiePropertyKey("HttpOnly"): "TRUE"])
        })
        jar.flush()
        try? LoginStore.delete()
        Log.app.notice("Tango login imported from Safari")
        return true
    }

    private func confirmImport() {
        do {
            guard var inbox = try LoginStore.load() else { loginView?.show(reason: "No Tango login was imported yet.", pending: false); return }
            inbox.handoffComplete = true
            try LoginStore.save(inbox)
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
                jar.remove { $0.domain.hasSuffix("tango.me") && $0.name.hasPrefix("Tango-") }
                jar.set(cookies)
                jar.flush()
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

// The PC's Tango login for this phone (packages/server, `/api/tango/phone-session`): the PC
// signs in with a fresh browser profile and returns that new session's cookies. Asking needs
// the key built into the app (a private build input); without it there is no shortcut.
@MainActor
final class TangoPCLogin {
    private let base = URL(string: "https://192.168.1.197:9999")!
    private let key: String
    private let http = HTTPClient(.init(connectionsPerHost: 2, requestTimeout: 120, resourceTimeout: 150))

    init?() {
        guard let key = Bundle.main.object(forInfoDictionaryKey: "TangoPhoneKey") as? String, !key.isEmpty else { return nil }
        self.key = key
    }

    func available() async -> Bool {
        guard let response = try? await http.send(HTTPRequest(base.appendingPathComponent("api/tango/phone-session"), headers: ["X-Phone-Key": key],
                                                              retry: .never, timeout: 5, accept: Set(300...599))) else { return false }
        return response.status == 200 && (try? response.json([String: Bool].self))?["available"] == true
    }

    func newSession() async throws -> [HTTPCookie] {
        let response = try await http.send(HTTPRequest(base.appendingPathComponent("api/tango/phone-session"), method: "POST",
                                                       headers: ["X-Phone-Key": key, "Content-Type": "application/json"], body: Data("{}".utf8),
                                                       retry: .never, accept: Set(300...599)))
        struct Answer: Decodable {
            struct Cookie: Decodable { var name: String; var value: String; var domain: String; var path: String; var expires: Double? }
            var cookies: [Cookie]?
            var error: String?
        }
        let answer = try response.json(Answer.self)
        guard response.status == 200, let cookies = answer.cookies, cookies.contains(where: { $0.name == "Tango-RT" }) else {
            throw TangoError.failed(answer.error ?? "The PC answered \(response.status)")
        }
        return cookies.compactMap { cookie in
            var properties: [HTTPCookiePropertyKey: Any] = [.name: cookie.name, .value: cookie.value, .domain: cookie.domain, .path: cookie.path,
                                                            .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE"]
            if let expires = cookie.expires { properties[.expires] = Date(timeIntervalSince1970: expires) }
            return HTTPCookie(properties: properties)
        }
    }
}
