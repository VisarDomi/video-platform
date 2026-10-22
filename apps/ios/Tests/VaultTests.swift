import Foundation
import KitNet

// Video Vault's scrapers and list rules against pages shaped as the sites' own, and both
// sites paged through a stub network.

func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) {
    do { if try !condition() { print("FAIL: " + message); exit(1) } }
    catch { print("FAIL: \(message): \(error)"); exit(1) }
}

func ptRow(_ n: Int, _ title: String, _ length: String) -> String {
    "<div class=\"video-item\" data-item-id=\"\(n)\"><a class=\"thumb\" href=\"https://www.porntrex.com/video/\(n)/upload-\(n)/\"></a><div class=\"durations\"><i class=\"fa fa-clock-o\"></i> \(length)</div><p class=\"inf\"><a href=\"https://www.porntrex.com/video/\(n)/upload-\(n)/\">\(title)</a></p></div>"
}

let ptPager = "<div class=\"pagination\"><ul><li class=\"page\"><a aria-label=\"pagination\" href=\"#videos\" data-action=\"ajax\" data-parameters=\"sort_by:;from_my_videos:02\">02</a></li></ul></div>"
let ptFirst = "<div id=\"list_videos_my_uploaded_videos\">" + ptRow(1, "Ignored title [2026-01-20 140639 alice]", "61:22") + ptRow(2, "Bikinis [2026-01-21 235709 dilaras7]", "1:02:03") + "</div>" + ptPager
let ptSecond = "<div id=\"list_videos_my_uploaded_videos\">" + ptRow(3, "String panty 2026-07-13 162147 AI_channel", "4:42") + "</div>"

// The stub network: Porntrex's two pages.
final class Stub: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        var body = "<p>404</p>", status = 404
        if url.host == "www.porntrex.com", url.path(percentEncoded: true) == "/my/videos/" {
            if let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "status" })?.value.flatMap(Int.init) {
                body = "<p>Temporarily unavailable</p>"
                status = code
            } else {
                body = url.query?.contains("from_my_videos=2") == true ? ptSecond : ptFirst
                status = 200
            }
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

        let ptv = pt.videos
        let retired = VaultVideo(filename: "retired-1", provider: "retired", title: "2025-01-01 000000 old", pageUrl: "/old/", duration: 1)
        let ordered = Vault.order([retired] + ptv + [VaultVideo(filename: "porntrex-9", provider: "porntrex", title: "no time", pageUrl: "/video/9/x/", duration: 0)])
        expect(ordered.map(\.filename) == ["porntrex-1", "porntrex-2", "porntrex-9"], "Oldest recording first; retired cached providers excluded")
        expect(Vault.unique(ptv + ptv).count == 2, "One row per upload")
        expect(Uploads.streamer("2026-01-21 235709 dilaras7") == "dilaras7" && Uploads.streamer("2025-11-05 010222 bob | rotation-flag-left") == "bob", "Streamer for +/-")
        expect(Uploads.duration("1:02:03") == 3723 && Uploads.duration("16 min") == 960 && Uploads.duration("") == 0, "Durations")
        expect(Uploads.jsString(#"a&b\x41\n\'"#) == "a&bA\n'", "JavaScript escapes")
        print("PASS: order, marks, labels")

        let http = VaultHTTP(jar: CookieJar(file: nil), configure: { $0.protocolClasses = [Stub.self] })
        for status in [401, 403, 429, 503] {
            do {
                _ = try await http.read(.porntrex, "/my/videos/?status=\(status)")
                expect(false, "HTTP \(status) must report an unavailable page")
            } catch VaultError.failed { }
            catch { expect(false, "HTTP \(status) is not proof that the shared session ended") }
        }
        do {
            _ = try Porntrex.parse(SitePage(html: "<p>Checking your browser</p>", landed: "/cdn-cgi/challenge-platform/"), page: 1)
            expect(false, "Unexpected redirect must fail")
        } catch VaultError.failed { }
        catch { expect(false, "A challenge redirect is not a sign-out") }
        print("PASS: outages and unexpected redirects do not declare a sign-out")
        var cursor: Vault.Cursor?, all: [VaultVideo] = [], last: Vault.Page?
        repeat {
            let page = try await Vault.page(http, cursor: cursor)
            all += page.videos
            last = page
            cursor = page.next
        } while cursor != nil
        expect(all.map(\.filename) == ["porntrex-1", "porntrex-2"], "Porntrex pages listed")
        expect(last?.incomplete.isEmpty == true && last?.notices.isEmpty == true, "Authenticated Porntrex listing completes without a login notice")
        print("PASS: Porntrex paged; a signed-out site keeps its rows")
    }
}
