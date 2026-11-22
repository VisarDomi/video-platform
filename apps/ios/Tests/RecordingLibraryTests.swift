import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// The recordings library (App/LocalLibrary.swift): an app of the PC's HLS recordings.
@main
struct RecordingLibraryTests {
    static func main() throws {
        func check(_ condition: @autoclosure () -> Bool, _ label: String) {
            if !condition() { print("FAIL:", label); exit(1) }
        }
        let api = LocalAPI(server: URL(string: "https://192.0.2.10:29999/videos/ts-live")!, provider: "ts-live")
        check(api.server.absoluteString == "https://192.0.2.10:29999/", "the provider URL becomes the API origin")
        let recording = ServerVideo(filename: "2026-01-01 120000 some streamer", type: "original", size: 0, duration: 120, isLive: false,
                                    width: 1280, height: 720)
        let url = api.mediaURL(recording.filename)
        check(url.lastPathComponent == "playlist.m3u8" && url.path.hasPrefix("/hls/ts-live/"), "recordings play the PC's HLS playlist")
        let raw = api.describeRaw(recording)
        check(raw["local"] as? Bool == true && raw["live"] as? Bool == false, "recordings keep the edit contract")
        check((raw["media"] as? [String: String])?["kind"] == "hls", "HLS media kind")
        check(raw["displayWidth"] as? Double == 1280 && raw["displayHeight"] as? Double == 720, "probed dimensions reach the viewer")
        let membership = raw["membership"] as? [String: Any]
        check(membership?["identifier"] as? String == "some streamer" && membership?["lists"] as? [String] == ["ts-live"], "the streamer reaches the +/- button")
        check(raw["renamable"] == nil && raw["fileId"] == nil, "recordings offer no file renaming")
        // A cache written before the recordings library was split from original files still loads.
        let older = #"{"provider":"ts-live","epoch":"e","revision":3,"videos":[{"filename":"a","type":"original","size":1,"duration":2,"isLive":false,"fileId":null,"videoCodec":"h264","width":640,"height":480}]}"#
        let cache = try JSONDecoder().decode(ListCache.self, from: Data(older.utf8))
        check(cache.videos.first?.width == 640 && cache.revision == 3, "older list caches decode")
        let edited = ServerVideo(filename: recording.filename, type: "edited", size: 0, duration: 60, isLive: false)
        let set = ChangeSet(epoch: "e", revision: 4, videos: nil, changes: [.init(revision: 4, item: edited, removed: nil)])
        check(mergingLocalVideos([recording], set) == [edited, recording], "a variant joins beside its recording in the PC's order")
        let removal = ChangeSet(epoch: "e", revision: 5, videos: nil, changes: [.init(revision: 5, item: nil, removed: .init(filename: recording.filename, type: "edited"))])
        check(mergingLocalVideos([edited, recording], removal) == [recording], "a removal drops only its variant")
        print("PASS: recordings library (HLS playlists, edit contract, dimensions, membership, cache compatibility, change merging)")
    }
}
