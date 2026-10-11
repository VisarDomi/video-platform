import Foundation

// What the viewer asks of whoever shows its list: the web page (online apps, ViewerBridge)
// or the native list (local apps, LocalListController).
@MainActor
protocol ViewerHost: AnyObject {
    // A playback source for a video that has none (Video Vault's pages).
    func resolve(_ video: ViewerVideo) async throws -> MediaSource
    // A live streamer's co-streamers (Tango).
    func related(_ video: ViewerVideo) async throws -> [ViewerVideo]
    func follow(_ video: ViewerVideo, _ follow: Bool) async throws
    func block(_ video: ViewerVideo) async throws
    // A stream that ended or was blocked leaves the list.
    func remove(_ filename: String)
    // Co-streamers join the list's end.
    func append(_ videos: [ViewerVideo])
    // The viewer's current video, shown as last viewed; `reveal` scrolls the row into view.
    func highlight(_ filename: String, reveal: Bool)
    // The video's recording changed on the PC (saved, cut or returned).
    func changed(_ video: ViewerVideo)
    // The site needs signing in again.
    func login()
}

extension ViewerBridge: ViewerHost {
    func related(_ video: ViewerVideo) async throws -> [ViewerVideo] {
        (try await call("related", [video.raw]) as? [Any] ?? []).compactMap(ViewerVideo.init)
    }
    func follow(_ video: ViewerVideo, _ follow: Bool) async throws { _ = try await call("follow", [video.raw, follow]) }
    func block(_ video: ViewerVideo) async throws { _ = try await call("block", [video.raw]) }
    func remove(_ filename: String) { send("remove", [filename]) }
    func append(_ videos: [ViewerVideo]) { send("append", [videos.map(\.raw)]) }
    func highlight(_ filename: String, reveal: Bool) { send("highlight", [filename, reveal]) }
    func changed(_ video: ViewerVideo) {}
    func login() { send("login") }
}
