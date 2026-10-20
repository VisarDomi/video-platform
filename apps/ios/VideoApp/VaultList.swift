import UIKit
import WebKit
import KitCore
import KitNet

// Video Vault keeps the last complete Porntrex list and refreshes natively
// with the shared session; a signed-out session retains its earlier rows.
@MainActor
final class VaultListController: VideoListController {
    struct Kept: Codable {
        var videos: [VaultVideo]
        var notices: [VaultNotice]
        var savedAt: Date
    }

    private let jar: CookieJar
    private let http: VaultHTTP
    private let keptWriter: BackgroundWriter
    private var shown: [VaultVideo] = []
    private var fresh: [VaultVideo] = []
    private var notices: [VaultNotice] = []
    private var loading: Task<Void, Never>?
    private var lastLoad: Date?

    init() {
        let directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support/LocalVideos")
        jar = CookieJar(file: directory.appendingPathComponent("cookies.json"))
        http = VaultHTTP(jar: jar)
        keptWriter = BackgroundWriter(url: directory.appendingPathComponent("vault-list.json"), label: "vault-list")
        let media = ViewerMedia(jar: jar, userAgent: Uploads.userAgent) { video in VaultSite(rawValue: video.provider).map { $0.origin.absoluteString + "/" } }
        super.init(viewerProvider: "vault", directory: directory, media: media)
        bytesPerSecond = Uploads.bytesPerSecond
        if let kept = try? DurableFile.readJSON(Kept.self, from: keptWriter.url) {
            shown = Vault.order(kept.videos)
            notices = kept.notices.filter { !$0.login }
            publish()
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override func viewDidLoad() {
        super.viewDidLoad()
        DebugState.shared.register("vault") { [weak self] in
            guard let self else { return [:] }
            return ["shown": shown.count, "fresh": fresh.count, "loading": loading != nil, "notices": notices.map(\.text),
                    "cookies": jar.all.map { "\($0.domain) \($0.name)" }]
        }
        migrateCookies { [weak self] in
            guard let self else { return }
            acceptSession()
            reload()
        }
    }

    // MARK: app lifecycle (from SceneDelegate)

    func resumed(afterBackground: Bool) {
        acceptSession()
        if lastLoad.map({ Date().timeIntervalSince($0) > 600 }) ?? true { reload() }
    }

    func paused() {
        flushState()
        jar.flush()
        keptWriter.flush()
    }

    // MARK: the list

    // Porntrex from its first page, behind the rows already shown; each page joins in order.
    override func reload() {
        loading?.cancel()
        fresh = []
        lastLoad = Date()
        loading = Task { [weak self] in
            var cursor: Vault.Cursor?
            var delay = 1.0
            while !Task.isCancelled {
                guard let self else { return }
                do {
                    let page = try await Vault.page(http, cursor: cursor)
                    guard !Task.isCancelled else { return }
                    await absorb(page)
                    guard !Task.isCancelled else { return }
                    hideFailure()
                    if refresh.isRefreshing { refresh.endRefreshing() }
                    delay = 1
                    guard let next = page.next else { break }
                    cursor = next
                } catch {
                    guard !Task.isCancelled else { return }
                    if refresh.isRefreshing { refresh.endRefreshing() }
                    if shown.isEmpty { showFailure("Can't reach the upload site.\n\(error.localizedDescription)") }
                    try? await Task.sleep(for: .seconds(delay))
                    delay = min(delay * 2, 30)
                }
            }
            self?.loading = nil
        }
    }

    // Until the reload finishes the earlier rows stay with the uploads read so far; then only
    // what was listed remains, except the rows of a site that could not be listed.
    // The merging, ordering and matching of every row happen off the main thread (a page
    // arrives every second or so while the list may be scrolling); only the result is set.
    private func absorb(_ page: Vault.Page) async {
        let done = page.next == nil
        let (previous, current) = (self.fresh, shown)
        let (fresh, shown, built) = await Task.detached(priority: .userInitiated) {
            let fresh = Vault.unique(previous + page.videos)
            let earlier = done ? current.filter { video in video.site.map { page.incomplete.contains($0) } ?? false } : current
            let shown = Vault.order(Vault.unique(fresh + earlier))
            return (fresh, shown, Self.rows(shown))
        }.value
        self.fresh = done ? [] : fresh
        self.shown = shown
        notices = page.notices
        if done { keptWriter.save(json: Kept(videos: shown, notices: notices, savedAt: Date())) }
        publish(built)
    }

    private struct Rows: Sendable {
        var videos: [ViewerVideo]
        var marks: [String: String]
        var looks: [ViewerVideo.Look]
    }

    // The rows as the list shows them (marks, streamers, looks), worked out off the main thread.
    private nonisolated static func rows(_ shown: [VaultVideo]) -> Rows {
        let videos = shown.map { describe($0, streamer: Uploads.streamer($0.title)) }
        return Rows(videos: videos, marks: [:], looks: videos.map(\.look))
    }

    private func publish(_ built: Rows? = nil) {
        let rows = built ?? Self.rows(shown)
        setVideos(rows.videos, marks: rows.marks, looks: rows.looks)
        setNotices(notices.map { ($0.text, nil) })
    }

    // As the website described an upload to the viewer: no source until asked; +/- on whichever
    // download list has the recording's streamer.
    private nonisolated static func describe(_ video: VaultVideo, streamer: String?) -> ViewerVideo {
        var raw: [String: Any] = [
            "filename": video.filename, "provider": video.provider, "type": "original", "title": video.title, "pageUrl": video.pageUrl,
            "duration": video.duration, "size": 0, "isLive": false, "local": false, "live": false,
        ]
        if let streamer { raw["membership"] = ["lists": ["tango", "fc2", "sc"], "identifier": streamer, "choose": true] }
        return ViewerVideo(raw)!
    }

    // MARK: ViewerHost

    override func resolve(_ video: ViewerVideo) async throws -> MediaSource {
        guard VaultSite(rawValue: video.provider) == .porntrex, let page = video.pageUrl else { throw ViewerFailure.page("Unknown upload.") }
        do {
            let source = try await Porntrex.source(http, pageUrl: page)
            return MediaSource(url: source.url, kind: source.kind)
        } catch VaultError.signedOut(_, let text) {
            throw ViewerFailure.authentication(text)
        }
    }

    override func login() {
        if !notices.contains(Vault.signedOut(.porntrex)) { notices.append(Vault.signedOut(.porntrex)); publish() }
    }

    // MARK: cookies

    // The web version's logins lived in WebKit's cookies (and a backup of the login cookies);
    // the first native launch takes them into the app's own jar, once.
    private func migrateCookies(_ done: @escaping () -> Void) {
        let marker = directory.appendingPathComponent("cookies-migrated")
        guard !FileManager.default.fileExists(atPath: marker.path) else { return done() }
        let hosts = VaultSite.allCases.flatMap(\.hosts)
        let onSite: (HTTPCookie) -> Bool = { cookie in
            let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
            return hosts.contains { domain == $0 || domain.hasSuffix("." + $0) }
        }
        let backup = (try? Data(contentsOf: directory.appendingPathComponent("login-cookies.plist")))
            .flatMap { try? PropertyListSerialization.propertyList(from: $0, format: nil) as? [[String: Any]] } ?? []
        let saved = backup.compactMap { item in HTTPCookie(properties: Dictionary(uniqueKeysWithValues: item.map { (HTTPCookiePropertyKey($0.key), $0.value) })) }
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else { return }
            let site = cookies.filter(onSite)
            let missing = saved.filter(onSite).filter { old in !site.contains { $0.name == old.name && $0.domain == old.domain && $0.path == old.path } }
            jar.set(missing + site)
            jar.flush()
            try? DurableFile.write(Data(), to: marker)
            Log.app.notice("Moved \(site.count + missing.count) cookies out of WebKit")
            done()
        }
    }

    // The PC's Porntrex session (packages/pipeline ptrexPhone.ts, through devicectl): it replaces
    // the phone's, never signs in (that would sign the pipeline out), and the answer is left for
    // the PC to read.
    private func acceptSession() {
        let inbox = directory.appendingPathComponent("porntrex-session.json")
        guard let data = try? Data(contentsOf: inbox) else { return }
        try? FileManager.default.removeItem(at: inbox)
        struct Inbox: Decodable {
            struct Cookie: Decodable { var name: String; var value: String; var domain: String; var path: String; var secure: Bool?; var httpOnly: Bool? }
            var id: String
            var cookies: [Cookie]
        }
        guard let session = try? JSONDecoder().decode(Inbox.self, from: data) else { return }
        let names = Set(["kt_member"] + session.cookies.map(\.name))
        jar.remove { cookie in names.contains(cookie.name) && VaultSite.porntrex.hosts.contains(cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) }
        let expires = Date().addingTimeInterval(400 * 24 * 3600)
        jar.set(session.cookies.compactMap { cookie in
            var properties: [HTTPCookiePropertyKey: Any] = [.name: cookie.name, .value: cookie.value, .domain: cookie.domain, .path: cookie.path, .expires: expires]
            if cookie.secure == true { properties[.secure] = "TRUE" }
            if cookie.httpOnly == true { properties[HTTPCookiePropertyKey("HttpOnly")] = "TRUE" }
            return HTTPCookie(properties: properties)
        })
        jar.flush()
        let http = http, result = directory.appendingPathComponent("porntrex-session-result.json")
        Task { [weak self] in
            var answer: [String: Any] = ["id": session.id, "loggedIn": false, "finalPath": ""]
            if let page = try? await http.read(.porntrex, "/upload-video/?connected=\(Int(Date().timeIntervalSince1970))") {
                answer["loggedIn"] = page.html.contains("name=\"content\"")
                answer["finalPath"] = URL(string: page.landed, relativeTo: VaultSite.porntrex.origin)?.path ?? page.landed
            }
            if let data = try? JSONSerialization.data(withJSONObject: answer) { try? DurableFile.write(data, to: result) }
            self?.reload()
        }
    }
}

