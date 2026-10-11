import AVFoundation
import UIKit
import KitNet

// Builds the player's assets. PC recordings play straight from the PC's HLS (the phone trusts
// its certificate). Video Vault's media gets its site's Referer, Safari's user agent and the
// app's cookies. Tango's playlists need its stream tokens, which live 10 s (TangoSession), so
// they come through TangoPlaylists; its segments need none and load directly.
@MainActor
final class ViewerMedia {
    private let jar: CookieJar?
    private let userAgent: String?
    private let referer: ((ViewerVideo) -> String?)?
    private let tango: TangoPlaylists?

    // Local apps: their recordings need neither cookies nor a Referer.
    init() {
        jar = nil
        userAgent = nil
        referer = nil
        tango = nil
    }

    init(jar: CookieJar, userAgent: String, referer: @escaping (ViewerVideo) -> String?) {
        self.jar = jar
        self.userAgent = userAgent
        self.referer = referer
        tango = nil
    }

    init(tango session: TangoSession) {
        jar = nil
        userAgent = nil
        referer = nil
        tango = TangoPlaylists(tokens: session)
    }

    func start() { tango?.tokens.start() }
    func stop() { tango?.tokens.stop() }

    func asset(_ source: MediaSource, for video: ViewerVideo) async -> AVURLAsset {
        if let tango, video.liveStream { return tango.asset(source.url) }
        guard let jar, !video.local else { return AVURLAsset(url: source.url) }
        var headers: [String: String] = [:]
        if let referer = referer?(video) { headers["Referer"] = referer }
        if let userAgent { headers["User-Agent"] = userAgent }
        return AVURLAsset(url: source.url, options: ["AVURLAssetHTTPHeaderFieldsKey": headers, AVURLAssetHTTPCookiesKey: jar.cookies(for: source.url)])
    }
}

// Tango's master and media playlists through a resource loader: each request (including a
// live media playlist's reloads) is fetched with the current stream tokens. Playlist addresses
// keep the loader's scheme; segment, key and map addresses become absolute https.
final class TangoPlaylists: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    static let scheme = "tangohls"
    let tokens: TangoSession
    private let queue = DispatchQueue(label: "VideoApp.TangoPlaylists")

    init(tokens: TangoSession) { self.tokens = tokens }

    func asset(_ url: URL) -> AVURLAsset {
        let asset = AVURLAsset(url: Self.swap(url, to: Self.scheme))
        asset.resourceLoader.setDelegate(self, queue: queue)
        return asset
    }

    private static func swap(_ url: URL, to scheme: String) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.scheme = scheme
        return components.url!
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        guard let url = loadingRequest.request.url, url.scheme == Self.scheme else { return false }
        let real = Self.swap(url, to: "https")
        let request = UncheckedRequest(value: loadingRequest)
        Task {
            do {
                let (data, status) = try await tokens.playlist(real)
                guard status == 200 else {
                    request.value.finishLoading(with: NSError(domain: NSURLErrorDomain, code: status == 404 || status == 410
                        ? NSURLErrorFileDoesNotExist : NSURLErrorBadServerResponse, userInfo: ["status": status]))
                    return
                }
                let text = Self.rewrite(String(decoding: data, as: UTF8.self), base: real)
                request.value.dataRequest?.respond(with: Data(text.utf8))
                request.value.finishLoading()
            } catch {
                request.value.finishLoading(with: error)
            }
        }
        return true
    }

    private struct UncheckedRequest: @unchecked Sendable { let value: AVAssetResourceLoadingRequest }

    static func rewrite(_ text: String, base: URL) -> String {
        var playlistNext = false
        return text.components(separatedBy: "\n").map { raw -> String in
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { return raw }
            if line.hasPrefix("#") {
                if line.hasPrefix("#EXT-X-STREAM-INF") { playlistNext = true }
                let playlistTag = line.hasPrefix("#EXT-X-MEDIA") || line.hasPrefix("#EXT-X-I-FRAME-STREAM-INF")
                return replacingURIAttribute(line) { uri in address(uri, base: base, playlist: playlistTag) }
            }
            defer { playlistNext = false }
            return address(line, base: base, playlist: playlistNext || line.lowercased().contains(".m3u8"))
        }.joined(separator: "\n")
    }

    private static func address(_ uri: String, base: URL, playlist: Bool) -> String {
        guard let url = URL(string: uri, relativeTo: base)?.absoluteURL else { return uri }
        return playlist ? swap(url, to: scheme).absoluteString : url.absoluteString
    }

    private static func replacingURIAttribute(_ line: String, _ transform: (String) -> String) -> String {
        guard let start = line.range(of: "URI=\"") else { return line }
        guard let end = line[start.upperBound...].firstIndex(of: "\"") else { return line }
        return line.replacingCharacters(in: start.upperBound..<end, with: transform(String(line[start.upperBound..<end])))
    }
}
