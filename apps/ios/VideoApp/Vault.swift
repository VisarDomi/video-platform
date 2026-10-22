import Foundation
import KitHTML
import KitNet

// Video Vault: the signed-in Porntrex uploads, oldest recording first.
// Pages are fetched and parsed, never executed, with the app's own cookies (CookieJar).

enum VaultSite: String, CaseIterable, Codable, Sendable {
    case porntrex

    var origin: URL { URL(string: "https://www.porntrex.com")! }
    var hosts: [String] { ["porntrex.com", "www.porntrex.com"] }
    var name: String { "Porntrex" }
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

// A message above the list. Authentication is shared from the PC.
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

// MARK: - Upload labels and media

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

    // The recording label supplies the streamer for the +/- button.
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

// Porntrex HTTP: pages with the app's cookies and Safari's headers; media playlists without cookies.
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
        // Proxy/CDN refusals are not proof that the shared PHP session ended.
        // Only the protected page's explicit login redirect/form decides that.
        guard (200...299).contains(response.status) else { throw VaultError.failed("\(site.name) page unavailable (\(response.status)).") }
        guard site.hosts.contains(response.url.host ?? "") else { throw VaultError.failed("\(site.name) left this site.") }
        return SitePage(html: response.text, landed: response.url.path(percentEncoded: true) + (response.url.query.map { "?" + $0 } ?? ""))
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
            if landed.range(of: #"^/(?:login/?)?$"#, options: .regularExpression) != nil || password {
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

// MARK: - Porntrex upload list

enum Vault {
    struct Cursor: Codable, Sendable, Equatable { var porntrex: Int? }
    struct Page: Sendable {
        var videos: [VaultVideo]
        var next: Cursor?
        var notices: [VaultNotice]
        var incomplete: Set<VaultSite>
    }

    static func signedOut(_ site: VaultSite) -> VaultNotice {
        VaultNotice(text: "Porntrex is signed out: restore the shared session from the PC. Its uploads below are from the last complete list.", login: false)
    }

    static func page(_ http: VaultHTTP, cursor: Cursor?) async throws -> Page {
        do {
            let page = try await Porntrex.page(http, cursor: cursor?.porntrex)
            return Page(videos: page.videos, next: page.next.map { Cursor(porntrex: $0) }, notices: [], incomplete: [])
        } catch VaultError.signedOut {
            return Page(videos: [], next: nil, notices: [signedOut(.porntrex)], incomplete: [.porntrex])
        }
    }

    // Oldest recording first; uploads without a timestamp last, in site order.
    static func order(_ videos: [VaultVideo]) -> [VaultVideo] {
        videos.filter { $0.site == .porntrex }.enumerated().map { ($0.element, $0.offset, Uploads.time($0.element.title)) }.sorted { a, b in
            switch (a.2, b.2) {
            case let (x?, y?): return x != y ? x < y : a.1 < b.1
            case (.some, nil): return true
            case (nil, .some): return false
            default: return a.1 < b.1
            }
        }.map(\.0)
    }

    static func unique(_ videos: [VaultVideo]) -> [VaultVideo] {
        var seen = Set<String>()
        return videos.filter { seen.insert($0.filename).inserted }
    }
}
