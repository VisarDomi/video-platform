import Foundation

// What the viewer asks of whoever shows its list (VideoList.swift and its subclasses).
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

// Why a request for the viewer failed; `authentication` closes the viewer and asks for a login.
enum ViewerFailure: LocalizedError {
    case authentication(String), page(String)
    var errorDescription: String? {
        switch self { case .authentication(let message), .page(let message): message }
    }
}
