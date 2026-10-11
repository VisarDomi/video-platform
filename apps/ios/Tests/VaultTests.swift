import Foundation
import KitNet

// Video Vault's scrapers and list rules against pages shaped as the sites' own (the same
// fixtures as packages/app test/providers.mjs), and both sites paged through a stub network.

func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) {
    do { if try !condition() { print("FAIL: " + message); exit(1) } }
    catch { print("FAIL: \(message): \(error)"); exit(1) }
}

func xvRow(_ n: Int, _ title: String, _ length: String) -> String {
    "<div id=\"listing-video-\(n)\"><p class=\"title\"><a href=\"https://ads.invalid/\(n)\">Ad</a><a href=\"/video.fixture\(n)/upload_\(n)\">\(title)</a></p><p>Uploaded 5 days ago - Duration: \(length)</p></div>"
}

func ptRow(_ n: Int, _ title: String, _ length: String) -> String {
    "<div class=\"video-item\" data-item-id=\"\(n)\"><a class=\"thumb\" href=\"https://www.porntrex.com/video/\(n)/upload-\(n)/\"></a><div class=\"durations\"><i class=\"fa fa-clock-o\"></i> \(length)</div><p class=\"inf\"><a href=\"https://www.porntrex.com/video/\(n)/upload-\(n)/\">\(title)</a></p></div>"
}

let xvFirst = "<a href=\"/account/uploads/new\">Upload</a>" + xvRow(1, "Ignored title [2026-01-20 140639 alice]", "16 min")
    + xvRow(2, "Rotated [2025-11-05 010222 bob | rotation-flag-left]", "1 h 2 min 3 sec")
    + "<div class=\"pagination\"><a href=\"https://ads.invalid/next\">Ad</a><a href=\"/account/uploads/1\">Next</a></div>"
let xvSecond = "<a href=\"/account/uploads/new\">Upload</a>" + xvRow(3, "2023-10-04 155600 [68190398] asahi", "02:30") + xvRow(4, "Full title [no timestamp]", "10 min")
let ptPager = "<div class=\"pagination\"><ul><li class=\"page\"><a aria-label=\"pagination\" href=\"#videos\" data-action=\"ajax\" data-parameters=\"sort_by:;from_my_videos:02\">02</a></li></ul></div>"
let ptFirst = "<div id=\"list_videos_my_uploaded_videos\">" + ptRow(1, "Ignored title [2026-01-20 140639 alice]", "61:22") + ptRow(2, "Bikinis [2026-01-21 235709 dilaras7]", "1:02:03") + "</div>" + ptPager
let ptSecond = "<div id=\"list_videos_my_uploaded_videos\">" + ptRow(3, "String panty 2026-07-13 162147 AI_channel", "4:42") + "</div>"

// The stub network: XVideos signed out, Porntrex's two pages.
final class Stub: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        var body = "<p>404</p>", status = 404
        if url.host == "www.xvideos.com", url.path.hasPrefix("/account/uploads") { body = "<form><input type=\"password\"></form>"; status = 200 }
        if url.host == "www.porntrex.com", url.path(percentEncoded: true) == "/my/videos/" {
            body = url.query?.contains("from_my_videos=2") == true ? ptSecond : ptFirst
            status = 200
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/html"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main
struct VaultTests {
    static func main() async throws {
        let first = try XVideos.parse(SitePage(html: xvFirst, landed: "/account/uploads"), requested: "/account/uploads", cursor: .init(pending: [], visited: []))
        expect(first.videos.map(\.filename) == ["xvideos-1", "xvideos-2"], "XVideos rows (ads skipped)")
        expect(first.videos[0].title == "2026-01-20 140639 alice" && first.videos[0].duration == 960 && first.videos[0].pageUrl == "/video.fixture1/upload_1", "XVideos label, duration, page")
        expect(first.videos[1].title == "2025-11-05 010222 bob | rotation-flag-left" && first.videos[1].duration == 3723, "Split label and spelled-out duration")
        expect(first.next == XVideos.Cursor(pending: ["/account/uploads/1"], visited: ["/account/uploads"]), "XVideos pages follow its links")
        let second = try XVideos.parse(SitePage(html: xvSecond, landed: "/account/uploads/1"), requested: "/account/uploads/1", cursor: .init(pending: [], visited: first.next!.visited))
        expect(second.videos.isEmpty && second.next == nil, "Manual uploads without a bracketed recording are not listed")
        do { _ = try XVideos.parse(SitePage(html: "<input type=\"password\">", landed: "/account/uploads"), requested: "/account/uploads", cursor: .init(pending: [], visited: [])); expect(false, "Signed out") }
        catch VaultError.signedOut(let site, _) { expect(site == .xvideos, "XVideos signed out") }
        do { _ = try XVideos.parse(SitePage(html: xvFirst, landed: "/"), requested: "/account/uploads", cursor: .init(pending: [], visited: [])); expect(false, "Redirect") }
        catch VaultError.failed(let text) { expect(text.contains("redirected"), "A redirected uploads page fails") }
        print("PASS: XVideos uploads, pages, sign-in and redirects")

        let page = "<script type=\"text/plain\">html5player.setVideoHLS('https://media.invalid/video.fixture1/hls_low.m3u8?signature=fixture')</script>"
        let hls = try XVideos.playerSource(page, "setVideoHLS")
        expect(hls?.absoluteString == "https://media.invalid/video.fixture1/hls_low.m3u8?signature=fixture", "setVideoHLS read, not run")
        let master = XVideos.fullQualityMaster(hls!)
        expect(master.absoluteString == "https://media.invalid/video.fixture1/hls.m3u8?signature=fixture", "Full-quality master")
        let best = try XVideos.highestVariant("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1280x720\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n1080.m3u8?signature=fixture", master: master)
        expect(best.url.absoluteString == "https://media.invalid/video.fixture1/1080.m3u8?signature=fixture" && best.quality == "1080p", "Highest resolution variant")
        do { _ = try XVideos.highestVariant("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO=\"a\"\nx.m3u8", master: master); expect(false, "External tracks") } catch {}
        expect(try XVideos.playerSource("<script>html5player.setVideoUrlHigh('https:\\/\\/cdn.invalid\\/v.mp4');</script>", "setVideoUrlHigh")?.absoluteString == "https://cdn.invalid/v.mp4", "Escaped MP4 source")
        print("PASS: XVideos sources")

        let pt = try Porntrex.parse(SitePage(html: ptFirst, landed: "/my/videos/"), page: 1)
        expect(pt.videos[0].pageUrl == "/video/1/upload-1/", "Porntrex page keeps its trailing slash")
        expect(pt.videos.map(\.filename) == ["porntrex-1", "porntrex-2"] && pt.videos[0].duration == 3682 && pt.videos[1].duration == 3723 && pt.next == 2, "Porntrex rows and its AJAX page link")
        let pt2 = try Porntrex.parse(SitePage(html: ptSecond, landed: "/my/videos/?mode=async"), page: 2)
        expect(pt2.videos.isEmpty && pt2.next == nil, "Porntrex's last page")
        do { _ = try Porntrex.parse(SitePage(html: "<p>home</p>", landed: "/"), page: 1); expect(false, "Signed out") }
        catch VaultError.signedOut(let site, _) { expect(site == .porntrex, "Porntrex signed out (sent home)") }
        let id = 7, file = { (q: String) in "https://www.porntrex.com/get_file/8/fixture\(id)/\(q).mp4/" }
        let flash = "<script>var flashvars = { video_id: '\(id)', video_url: '\(file("480p"))', video_url_text: '480p', video_alt_url2: '\(file("2160p"))', video_alt_url2_text: '2160p 4K', video_alt_url3: '\(file("1080p"))', video_alt_url3_text: '1080p FHD', video_tags: 'Tango' };</script>"
        let sources = try Porntrex.sources(flash, base: URL(string: "https://www.porntrex.com/video/7/x/")!)
        expect(sources.map(\.quality) == ["2160p 4K", "1080p FHD", "480p"] && sources[0].url.absoluteString == file("2160p"), "Porntrex qualities, highest first")
        do { _ = try Porntrex.sources("<script>var f = { video_url: 'function/0/https://x' };</script>", base: URL(string: "https://www.porntrex.com/")!); expect(false, "Encoded") } catch {}
        print("PASS: Porntrex uploads, pages, sign-in and sources")

        let xv = first.videos, ptv = pt.videos
        let ordered = Vault.order(xv + ptv + [VaultVideo(filename: "porntrex-9", provider: "porntrex", title: "no time", pageUrl: "/video/9/x/", duration: 0)])
        expect(ordered.map(\.filename) == ["xvideos-2", "xvideos-1", "porntrex-1", "porntrex-2", "porntrex-9"], "Oldest recording first, untimed last")
        expect(Vault.marks(xv + ptv) == ["xvideos-1": "Xvid", "porntrex-1": "Ptrex"], "The same recording on both sites is marked")
        expect(Vault.unique(ptv + ptv).count == 2, "One row per upload")
        expect(Uploads.streamer("2026-01-21 235709 dilaras7") == "dilaras7" && Uploads.streamer("2025-11-05 010222 bob | rotation-flag-left") == "bob", "Streamer for +/-")
        expect(Uploads.duration("1:02:03") == 3723 && Uploads.duration("16 min") == 960 && Uploads.duration("") == 0, "Durations")
        expect(Uploads.jsString(#"a&b\x41\n\'"#) == "a&bA\n'", "JavaScript escapes")
        print("PASS: order, marks, labels")

        let http = VaultHTTP(jar: CookieJar(file: nil), configure: { $0.protocolClasses = [Stub.self] })
        var cursor: Vault.Cursor?, all: [VaultVideo] = [], last: Vault.Page?
        repeat {
            let page = try await Vault.page(http, cursor: cursor)
            all += page.videos
            last = page
            cursor = page.next
        } while cursor != nil
        expect(all.map(\.filename) == ["porntrex-1", "porntrex-2"], "Porntrex listed while XVideos is signed out")
        expect(last?.incomplete == [.xvideos] && last?.notices.first?.login == true, "XVideos signed out: a notice to log in, its earlier rows kept")
        print("PASS: both sites paged; a signed-out site keeps its rows")
    }
}
