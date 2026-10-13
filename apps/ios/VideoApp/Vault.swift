import Foundation
import KitHTML
import KitNet

// Video Vault: the signed-in account's uploads on XVideos and Porntrex in one list, oldest
// recording first (packages/app providers/{uploadSite,xvideos,porntrex,vault}.ts, ported).
// Pages are fetched and parsed, never executed, with the app's own cookies (CookieJar).

enum VaultSite: String, CaseIterable, Codable, Sendable {
    case xvideos, porntrex

    var origin: URL { URL(string: self == .xvideos ? "https://www.xvideos.com" : "https://www.porntrex.com")! }
    var hosts: [String] { self == .xvideos ? ["xvideos.com", "www.xvideos.com"] : ["porntrex.com", "www.porntrex.com"] }
    var name: String { self == .xvideos ? "XVideos" : "Porntrex" }
    // Shown on a row when the same recording is on both sites.
    var mark: String { self == .xvideos ? "Xvid" : "Ptrex" }
}

// An upload as the list keeps it: `<site>-<id>`, its label (the recording), its page.
struct VaultVideo: Codable, Sendable, Equatable {
    var filename: String
    var provider: String
    var title: String
    var pageUrl: String
    var duration: Double

    var site: VaultSite? { VaultSite(rawValue: provider) }
}

// A message above the list; `login`: tapping it opens XVideos' sign-in.
struct VaultNotice: Codable, Sendable, Equatable {
    var text: String
    var login: Bool
}

enum VaultError: LocalizedError {
    case signedOut(VaultSite, String)
    case failed(String)
    var errorDescription: String? {
        switch self { case .signedOut(_, let text), .failed(let text): text }
    }
}

struct VaultSource: Sendable, Equatable {
    var url: URL
    var kind: String
    var quality: String
}

// MARK: - What both sites share

enum Uploads {
    static let bytesPerSecond = 4_000_000.0 / 8
    // Safari's iPhone user agent (iOS 26 reports a frozen OS version).
    static let userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1"

    private static let recorded = #"\b(\d{4}-\d{2}-\d{2})\s+(\d{6})\b"#
    private static let bracketed = #"\[([^\]]*\b\d{4}-\d{2}-\d{2}\s+\d{6}\b[^\]]*)\]"#

    // Only the pipeline's uploads: "[YYYY-MM-DD HHMMSS streamer]" in the title.
    static func isPipelineUpload(_ title: String) -> Bool { first(bracketed, in: title) != nil }

    // The bracketed recording without brackets; else the title from the timestamp on.
    static func label(_ title: String) -> String {
        if let inside = first(bracketed, in: title)?[1]?.trimmingCharacters(in: .whitespaces), !inside.isEmpty { return inside }
        guard let regex = compiled.regex(recorded, []), let match = regex.firstMatch(in: title, range: NSRange(location: 0, length: (title as NSString).length)),
              let range = Range(match.range, in: title) else { return title }
        return String(title[range.lowerBound...]).trimmingCharacters(in: .whitespaces)
    }

    // "YYYY-MM-DD HHMMSS", which sorts as text.
    static func time(_ label: String) -> String? {
        guard let match = first(recorded, in: label), let day = match[1], let clock = match[2] else { return nil }
        return day + " " + clock
    }

    // The label's streamer, for the +/- button (never from the page title: XVideos turns `_` into spaces there).
    static func streamer(_ label: String) -> String? {
        first(#"^\d{4}-\d{2}-\d{2}\s+\d{6}\s+(.+?)(?:\s+\|.*)?$"#, in: label)?[1] ?? nil
    }

    // "1:02:03", "02:30", "16 min" or "1 h 2 min 3 sec" in seconds; 0 when absent.
    static func duration(_ text: String) -> Double {
        if let clock = first(#"\b\d+(?::\d{2}){1,2}\b"#, in: text)?[0] {
            return clock.split(separator: ":").reduce(0) { $0 * 60 + (Double($1) ?? 0) }
        }
        guard let units = first(#"^\s*((?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*)+)"#, in: text, options: .caseInsensitive)?[1] else { return 0 }
        return matches(#"(\d+(?:\.\d+)?)\s*([hms])"#, in: units, options: .caseInsensitive).reduce(0) { total, match in
            let value = Double(match[1] ?? "") ?? 0
            switch match[2]?.lowercased() { case "h": return total + value * 3600; case "m": return total + value * 60; default: return total + value }
        }
    }

    // JavaScript string escapes only; scripts are never executed.
    static func jsString(_ raw: String) -> String {
        var out = "", characters = Array(raw), index = 0
        while index < characters.count {
            let character = characters[index]
            guard character == "\\", index + 1 < characters.count else { out.append(character); index += 1; continue }
            let next = characters[index + 1]
            if (next == "u" || next == "x"), case let width = next == "u" ? 4 : 2, index + 1 + width < characters.count,
               let code = UInt32(String(characters[(index + 2)...(index + 1 + width)]), radix: 16), let scalar = Unicode.Scalar(code) {
                out.unicodeScalars.append(scalar)
                index += 2 + width
                continue
            }
            switch next { case "n": out.append("\n"); case "r": out.append("\r"); case "t": out.append("\t"); default: out.append(next) }
            index += 2
        }
        return out
    }

    // The page's script contents (`<script>` of any type).
    static func scripts(_ html: String) -> [String] {
        matches(#"<script\b[^>]*>([\s\S]*?)</script>"#, in: html, options: .caseInsensitive).compactMap { $0[1] }
    }

    // A JS string literal right after `before` (a pattern without groups) in the page's scripts.
    static func scriptString(_ html: String, after before: String) -> String? {
        let pattern = before + #"(['"])((?:\\.|(?!\1)[^\\])*)\1"#
        for script in scripts(html) { if let match = first(pattern, in: script), let raw = match[2] { return jsString(raw) } }
        return nil
    }

    static func sourceURL(_ raw: String, base: URL? = nil) throws -> URL {
        guard let url = URL(string: raw, relativeTo: base)?.absoluteURL, url.scheme == "https" else { throw VaultError.failed("Unexpected video source protocol.") }
        return url
    }

    // Compiled once each: every row of every page is matched several times (labels, times,
    // streamers), and compiling a pattern costs far more than matching it.
    static func matches(_ pattern: String, in text: String, options: NSRegularExpression.Options = []) -> [[String?]] {
        guard let regex = compiled.regex(pattern, options) else { return [] }
        let ns = text as NSString
        return regex.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { match in
            (0..<match.numberOfRanges).map { index in
                let range = match.range(at: index)
                return range.location == NSNotFound ? nil : ns.substring(with: range)
            }
        }
    }

    static func first(_ pattern: String, in text: String, options: NSRegularExpression.Options = []) -> [String?]? {
        guard let regex = compiled.regex(pattern, options), let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length)) else { return nil }
        let ns = text as NSString
        return (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? nil : ns.substring(with: range)
        }
    }

    private static let compiled = Patterns()
}

final class Patterns: @unchecked Sendable {
    private let lock = NSLock()
    private var known: [String: NSRegularExpression] = [:]

    func regex(_ pattern: String, _ options: NSRegularExpression.Options) -> NSRegularExpression? {
        let key = "\(options.rawValue)|" + pattern
        if let regex = lock.withLock({ known[key] }) { return regex }
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return nil }
        lock.withLock { known[key] = regex }
        return regex
    }
}

// A fetched page of a site, and the path it landed on after redirects.
struct SitePage {
    var html: String
    var landed: String
}

// The two sites' HTTP: pages with the app's cookies and Safari's headers; media playlists without cookies.
struct VaultHTTP: Sendable {
    let pages: HTTPClient
    let media: HTTPClient

    init(jar: CookieJar, configure: (@Sendable (URLSessionConfiguration) -> Void)? = nil) {
        pages = HTTPClient(.init(userAgent: Uploads.userAgent, cookies: jar, connectionsPerHost: 4, requestTimeout: 30, resourceTimeout: 60, configure: configure))
        media = HTTPClient(.init(userAgent: Uploads.userAgent, connectionsPerHost: 4, requestTimeout: 30, resourceTimeout: 60, configure: configure))
    }

    func read(_ site: VaultSite, _ path: String) async throws -> SitePage {
        guard let url = URL(string: path, relativeTo: site.origin)?.absoluteURL, url.scheme == "https", site.hosts.contains(url.host ?? "") else {
            throw VaultError.failed("Unexpected \(site.name) page URL.")
        }
        let response = try await pages.send(HTTPRequest(url, headers: ["Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"],
                                                        referer: site.origin.absoluteString + "/", accept: Set(300...599)))
        if response.status == 401 || response.status == 403 { throw VaultError.signedOut(site, "\(site.name) login is required.") }
        guard (200...299).contains(response.status) else { throw VaultError.failed("\(site.name) page unavailable (\(response.status)).") }
        guard site.hosts.contains(response.url.host ?? "") else { throw VaultError.failed("\(site.name) left this site.") }
        return SitePage(html: response.text, landed: response.url.path(percentEncoded: true) + (response.url.query.map { "?" + $0 } ?? ""))
    }
}

// MARK: - XVideos

enum XVideos {
    static let uploads = "/account/uploads"
    static let listPath = #"^/account/uploads(?:/\d+)?/?$"#
    static let videoPath = #"^/video(?:\.[a-z0-9]+|[0-9]+|-[a-z0-9]+)/[^/]+/?$"#

    // Site order: pages are queued as the site links them.
    struct Cursor: Codable, Sendable, Equatable { var pending: [String]; var visited: [String] }

    // The first uploads page is also page 0.
    static func canonical(_ path: String) -> String {
        var path = path
        if path.hasSuffix("/") { path.removeLast() }
        if path.hasSuffix("/0") { path.removeLast(2) }
        return path
    }

    static func isList(_ path: String) -> Bool { path.range(of: listPath, options: .regularExpression) != nil }

    static func page(_ http: VaultHTTP, cursor: Cursor?) async throws -> (videos: [VaultVideo], next: Cursor?) {
        var cursor = cursor ?? Cursor(pending: [uploads], visited: [])
        guard let path = cursor.pending.first, (cursor.pending + cursor.visited).allSatisfy(isList) else { throw VaultError.failed("Invalid uploads page cursor.") }
        cursor.pending.removeFirst()
        let page = try await http.read(.xvideos, path)
        return try parse(page, requested: path, cursor: cursor)
    }

    static func parse(_ page: SitePage, requested path: String, cursor: Cursor) throws -> (videos: [VaultVideo], next: Cursor?) {
        let document = try HTMLDocument(page.html)
        let rows = try document.select("[id^=\"listing-video-\"]")
        if rows.isEmpty {
            if try document.first("a.social-login-icon[data-method=\"signin\"], input[type=\"password\"]") != nil {
                throw VaultError.signedOut(.xvideos, "Log in to XVideos at /account, then return to your uploads.")
            }
            if try document.first("a[href=\"/account/uploads/new\"]") == nil {
                throw VaultError.failed("Could not read your XVideos uploads. Open /account to check your session.")
            }
        }
        if canonical(URL(string: page.landed, relativeTo: VaultSite.xvideos.origin)?.path(percentEncoded: true) ?? page.landed) != canonical(path) {
            throw VaultError.failed("XVideos redirected this uploads page.")
        }
        var cursor = cursor
        cursor.visited.append(path)
        var queued = Set(cursor.visited + cursor.pending)
        let base = URL(string: path, relativeTo: VaultSite.xvideos.origin)!
        let linked = try document.select(".pagination a[href]").compactMap { link -> String? in
            guard let href = link["href"], let url = URL(string: href, relativeTo: base)?.absoluteURL,
                  VaultSite.xvideos.hosts.contains(url.host ?? ""), isList(url.path(percentEncoded: true)) else { return nil }
            return url.path(percentEncoded: true)
        }.sorted { (Int($0.split(separator: "/").dropFirst(2).first ?? "") ?? 0) < (Int($1.split(separator: "/").dropFirst(2).first ?? "") ?? 0) }
        for page in linked.map(canonical) where queued.insert(page).inserted { cursor.pending.append(page) }
        let videos = try rows.compactMap { row -> VaultVideo? in
            guard let id = Uploads.first(#"^listing-video-(\d+)$"#, in: row["id"] ?? "")?[1] else { return nil }
            let details = try row.first(".title + p")?.text ?? ""
            let seconds = Uploads.duration(details.components(separatedBy: "Duration:").dropFirst().first ?? "")
            for link in try row.select(".title a[href]") {
                if let video = upload(.xvideos, id: id, href: link["href"] ?? "", title: link.text, seconds: seconds, videoPath: videoPath) { return video }
            }
            return nil
        }
        return (videos, cursor.pending.isEmpty ? nil : cursor)
    }

    static func source(_ http: VaultHTTP, pageUrl: String) async throws -> VaultSource {
        let page = try await http.read(.xvideos, pageUrl)
        if let hls = try playerSource(page.html, "setVideoHLS") {
            let master = fullQualityMaster(hls)
            let response = try await http.media.send(HTTPRequest(master, referer: VaultSite.xvideos.origin.absoluteString + "/", accept: Set(300...599)))
            guard (200...299).contains(response.status) else { throw VaultError.failed("Could not load video qualities (\(response.status)).") }
            let best = try highestVariant(response.text, master: response.url)
            return VaultSource(url: best.url, kind: "hls", quality: best.quality)
        }
        if let high = try playerSource(page.html, "setVideoUrlHigh") { return VaultSource(url: high, kind: "mp4", quality: "High") }
        if let low = try playerSource(page.html, "setVideoUrlLow") { return VaultSource(url: low, kind: "mp4", quality: "Only available source") }
        throw VaultError.failed("This upload is unavailable or is still processing. Check its status in your XVideos account.")
    }

    static func playerSource(_ html: String, _ setter: String) throws -> URL? {
        try Uploads.scriptString(html, after: #"\bhtml5player\."# + setter + #"\(\s*"#).map { try Uploads.sourceURL($0) }
    }

    // XVideos gives Safari hls_low.m3u8, whose variants omit HD; the sibling master has them all.
    static func fullQualityMaster(_ source: URL) -> URL {
        guard var components = URLComponents(url: source, resolvingAgainstBaseURL: false), components.path.hasSuffix("/hls_low.m3u8") else { return source }
        components.path = String(components.path.dropLast("hls_low.m3u8".count)) + "hls.m3u8"
        return components.url ?? source
    }

    static func highestVariant(_ manifest: String, master: URL) throws -> (url: URL, quality: String) {
        guard manifest.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("#EXTM3U") else { throw VaultError.failed("Invalid XVideos quality playlist.") }
        let lines = manifest.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }
        var variants: [(url: URL, quality: String, pixels: Int, bandwidth: Int)] = []
        for (index, line) in lines.enumerated() where line.hasPrefix("#EXT-X-STREAM-INF:") {
            let resolution = Uploads.first(#"\bRESOLUTION=(\d+)x(\d+)"#, in: line)
            let width = Int(resolution?[1] ?? "") ?? 0, height = Int(resolution?[2] ?? "") ?? 0
            let bandwidth = Int(Uploads.first(#"(?:^|[:,])BANDWIDTH=(\d+)"#, in: line)?[1] ?? "") ?? 0
            guard index + 1 < lines.count, case let target = lines[index + 1], !target.isEmpty, !target.hasPrefix("#") else {
                throw VaultError.failed("Missing XVideos quality variant.")
            }
            if line.range(of: #"\b(?:AUDIO|VIDEO)=""#, options: .regularExpression) != nil { throw VaultError.failed("Unsupported external media tracks in XVideos playlist.") }
            variants.append((try Uploads.sourceURL(target, base: master), height > 0 ? "\(min(width, height))p" : "Highest bitrate", width * height, bandwidth))
        }
        guard let best = variants.enumerated().sorted(by: { a, b in
            a.element.pixels != b.element.pixels ? a.element.pixels > b.element.pixels
                : a.element.bandwidth != b.element.bandwidth ? a.element.bandwidth > b.element.bandwidth : a.offset < b.offset
        }).first?.element else { throw VaultError.failed("XVideos did not expose selectable video qualities.") }
        return (best.url, best.quality)
    }
}

// MARK: - Porntrex

enum Porntrex {
    static let uploads = "/my/videos/"
    static let videoPath = #"^/video/\d+/[^/]+/?$"#

    // 30 uploads per page; page N is the list's own async block.
    static func path(_ page: Int) -> String {
        page == 1 ? uploads : uploads + "?mode=async&function=get_block&block_id=list_videos_my_uploaded_videos&sort_by=&from_my_videos=\(page)"
    }

    static func page(_ http: VaultHTTP, cursor: Int?) async throws -> (videos: [VaultVideo], next: Int?) {
        let number = cursor ?? 1
        guard number >= (cursor == nil ? 1 : 2) else { throw VaultError.failed("Invalid uploads page cursor.") }
        return try parse(try await http.read(.porntrex, path(number)), page: number)
    }

    // Member pages send signed-out visitors to the home page.
    static func parse(_ page: SitePage, page number: Int) throws -> (videos: [VaultVideo], next: Int?) {
        let document = try HTMLDocument(page.html)
        guard try document.first("#list_videos_my_uploaded_videos") != nil else {
            let landed = URL(string: page.landed, relativeTo: VaultSite.porntrex.origin)?.path(percentEncoded: true) ?? page.landed
            let password = try document.first("input[type=\"password\"]") != nil
            if landed.range(of: #"^/my/videos/?$"#, options: .regularExpression) == nil || password {
                throw VaultError.signedOut(.porntrex, "Log in to Porntrex, then return to your videos.")
            }
            throw VaultError.failed("Could not read your Porntrex videos. Open /my/videos/ to check your session.")
        }
        let videos = try document.select("#list_videos_my_uploaded_videos [data-item-id]").compactMap { row -> VaultVideo? in
            guard let id = row["data-item-id"], id.allSatisfy(\.isNumber), !id.isEmpty,
                  let link = try row.first("p.inf a[href*=\"/video/\(id)/\"]") else { return nil }
            return upload(.porntrex, id: id, href: link["href"] ?? "", title: link.text, seconds: Uploads.duration(try row.first(".durations")?.text ?? ""), videoPath: videoPath)
        }
        let linked = try document.select("a[data-parameters*='from_my_videos:']").compactMap { link in
            Int(Uploads.first(#"from_my_videos:0*(\d+)"#, in: link["data-parameters"] ?? "")?[1] ?? "")
        }
        return (videos, linked.contains(number + 1) ? number + 1 : nil)
    }

    // The player's flashvars list one MP4 per quality (video_url, video_alt_url, video_alt_url2…,
    // each with a `_text` label such as "1080p FHD"); the highest resolution wins.
    static func source(_ http: VaultHTTP, pageUrl: String) async throws -> VaultSource {
        let page = try await http.read(.porntrex, pageUrl)
        guard let best = try sources(page.html, base: URL(string: pageUrl, relativeTo: VaultSite.porntrex.origin)!.absoluteURL).first else {
            throw VaultError.failed("This video is unavailable or is still processing. Check its status in your Porntrex account.")
        }
        return VaultSource(url: best.url, kind: "mp4", quality: best.quality)
    }

    static func sources(_ html: String, base: URL) throws -> [(url: URL, quality: String)] {
        for script in Uploads.scripts(html) {
            var fields: [(String, String)] = []
            for match in Uploads.matches(#"\b(video_(?:alt_)?url\d*(?:_text)?)\s*:\s*(['"])((?:\\.|(?!\2)[^\\])*)\2"#, in: script) {
                if let key = match[1], let raw = match[3] { fields.append((key, Uploads.jsString(raw))) }
            }
            let values = Dictionary(fields, uniquingKeysWith: { first, _ in first })
            guard values["video_url"] != nil else { continue }
            var found: [(url: URL, quality: String, height: Int, order: Int)] = []
            var seen = Set<String>()
            for (order, (key, raw)) in fields.enumerated() where !key.hasSuffix("_text") && !raw.isEmpty && seen.insert(key).inserted {
                if raw.hasPrefix("function/") { throw VaultError.failed("Porntrex returned an encoded video source.") }
                let quality = values[key + "_text"] ?? ""
                found.append((try Uploads.sourceURL(raw, base: base), quality.isEmpty ? "Only available source" : quality,
                              Int(Uploads.first(#"(\d{3,4})p"#, in: quality)?[1] ?? "") ?? 0, order))
            }
            return found.sorted { $0.height != $1.height ? $0.height > $1.height : $0.order < $1.order }.map { ($0.url, $0.quality) }
        }
        return []
    }
}

// An uploads row: only one of the site's video pages, and only the pipeline's uploads.
private func upload(_ site: VaultSite, id: String, href: String, title: String, seconds: Double, videoPath: String) -> VaultVideo? {
    guard let url = URL(string: href.trimmingCharacters(in: .whitespacesAndNewlines), relativeTo: site.origin)?.absoluteURL, url.scheme == "https",
          site.hosts.contains(url.host ?? ""), url.path(percentEncoded: true).range(of: videoPath, options: [.regularExpression, .caseInsensitive]) != nil,
          Uploads.isPipelineUpload(title) else { return nil }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    return VaultVideo(filename: "\(site.rawValue)-\(id)", provider: site.rawValue, title: Uploads.label(trimmed.isEmpty ? "Video \(id)" : trimmed),
                      pageUrl: url.path(percentEncoded: true), duration: seconds)
}

// MARK: - Both sites in one list

enum Vault {
    // Each site's next page (absent: the first; done: finished), and what went wrong so far.
    struct Cursor: Codable, Sendable, Equatable {
        var xvideos: XVideos.Cursor?
        var porntrex: Int?
        var done: Set<VaultSite> = []
        var notices: [VaultNotice] = []
        var incomplete: Set<VaultSite> = []
    }

    struct Page: Sendable {
        var videos: [VaultVideo]
        var next: Cursor?
        var notices: [VaultNotice]
        var incomplete: Set<VaultSite>
    }

    // A signed-out site keeps its earlier rows and says how to sign it back in. Porntrex is never
    // logged into on the phone: its newest login signs the pipeline out.
    static func signedOut(_ site: VaultSite) -> VaultNotice {
        site == .xvideos
            ? VaultNotice(text: "XVideos is signed out. Tap to log in; its uploads below are from the last complete list.", login: true)
            : VaultNotice(text: "Porntrex is signed out: run `npm run ptrex:connect-iphone` on the PC (do not log in here; it would sign the pipeline out). Its uploads below are from the last complete list.", login: false)
    }

    // Both sites' next pages at once. A site that fails for another reason is asked again with the
    // next round; a round where nothing progressed fails.
    static func page(_ http: VaultHTTP, cursor: Cursor?) async throws -> Page {
        var cursor = cursor ?? Cursor()
        let pending = VaultSite.allCases.filter { !cursor.done.contains($0) }
        let snapshot = cursor
        let results = await withTaskGroup(of: (VaultSite, Result<([VaultVideo], XVideos.Cursor?, Int?), Error>).self) { group in
            for site in pending {
                group.addTask {
                    do {
                        switch site {
                        case .xvideos:
                            let page = try await XVideos.page(http, cursor: snapshot.xvideos)
                            return (site, .success((page.videos, page.next, nil)))
                        case .porntrex:
                            let page = try await Porntrex.page(http, cursor: snapshot.porntrex)
                            return (site, .success((page.videos, nil, page.next)))
                        }
                    } catch { return (site, .failure(error)) }
                }
            }
            var results: [VaultSite: Result<([VaultVideo], XVideos.Cursor?, Int?), Error>] = [:]
            for await (site, result) in group { results[site] = result }
            return results
        }
        var videos: [VaultVideo] = [], progressed = false, failure: Error?
        // In site order: equal timestamps keep a stable order.
        for site in pending {
            switch results[site]! {
            case .success(let (list, xvideosNext, porntrexNext)):
                progressed = true
                videos += list
                switch site {
                case .xvideos: cursor.xvideos = xvideosNext; if xvideosNext == nil { cursor.done.insert(site) }
                case .porntrex: cursor.porntrex = porntrexNext; if porntrexNext == nil { cursor.done.insert(site) }
                }
            case .failure(let error):
                if case VaultError.signedOut = error {
                    progressed = true
                    cursor.done.insert(site)
                    cursor.notices.append(signedOut(site))
                    cursor.incomplete.insert(site)
                } else if failure == nil { failure = error }
            }
        }
        if let failure, !progressed { throw failure }
        let finished = VaultSite.allCases.allSatisfy { cursor.done.contains($0) }
        return Page(videos: videos, next: finished ? nil : cursor, notices: cursor.notices, incomplete: cursor.incomplete)
    }

    // Oldest recording first; uploads without a timestamp last, in site order.
    static func order(_ videos: [VaultVideo]) -> [VaultVideo] {
        videos.enumerated().map { ($0.element, $0.offset, Uploads.time($0.element.title)) }.sorted { a, b in
            switch (a.2, b.2) {
            case let (x?, y?): return x != y ? x < y : a.1 < b.1
            case (.some, nil): return true
            case (nil, .some): return false
            default: return a.1 < b.1
            }
        }.map(\.0)
    }

    // The same recording (date, time, streamer) on both sites: which site each row is.
    static func marks(_ videos: [VaultVideo]) -> [String: String] {
        func recording(_ video: VaultVideo) -> String? {
            guard let match = Uploads.first(#"\b(\d{4}-\d{2}-\d{2})\s+(\d{6})\b(?:\s+([^\s|]+))?"#, in: video.title) else { return nil }
            return [match[1], match[2], match[3]].compactMap { $0 }.joined(separator: " ")
        }
        var sites: [String: Set<String>] = [:]
        for video in videos { if let key = recording(video) { sites[key, default: []].insert(video.provider) } }
        var marks: [String: String] = [:]
        for video in videos {
            if let key = recording(video), sites[key]!.count > 1, let site = video.site { marks[video.filename] = site.mark }
        }
        return marks
    }

    // The first of each filename wins (a page's fresh entry over an earlier row).
    static func unique(_ videos: [VaultVideo]) -> [VaultVideo] {
        var seen = Set<String>()
        return videos.filter { seen.insert($0.filename).inserted }
    }
}
