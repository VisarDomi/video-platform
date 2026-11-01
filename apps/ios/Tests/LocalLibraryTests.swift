import Foundation

@main
struct LocalLibraryTests {
    static func main() throws {
        func check(_ condition: @autoclosure () -> Bool, _ label: String) {
            if !condition() { print("FAIL:", label); exit(1) }
        }
        let filename = "H416OVz6Vioi0 - video #1?%+.mp4"
        let mp4 = LocalAPI(server: URL(string: "https://192.168.1.197:9998/videos/bunkr")!, provider: "bunkr", mediaKind: .mp4)
        check(mp4.server.absoluteString == "https://192.168.1.197:9998/", "provider URL becomes the API origin, preserving its port")
        let url = mp4.mediaURL(filename)
        check(url.lastPathComponent == filename && url.query == nil && url.fragment == nil, "MP4 filenames remain one encoded path component")
        check(url.path.hasPrefix("/media/bunkr/") && !url.path.contains("playlist.m3u8"), "flat MP4s use direct file playback")
        let item = ServerVideo(filename: filename, type: "original", size: 1_832_651_522, duration: 569.642667, isLive: false)
        let raw = mp4.describeRaw(item)
        check(raw["local"] as? Bool == false && raw["membership"] == nil, "MP4s use the Vault-style viewer without HLS editing or streamer actions")
        check((raw["media"] as? [String: String])?["kind"] == "mp4", "MP4 media kind")
        check(raw["size"] as? Double == item.size && raw["duration"] as? Double == item.duration, "duration and actual file size reach the list")
        var portrait = item; portrait.width = 720; portrait.height = 1280
        let dimensioned = mp4.describeRaw(portrait)
        check(dimensioned["displayWidth"] as? Double == 720 && dimensioned["displayHeight"] as? Double == 1280, "display dimensions reach the viewer before playback")
        let decodedDimensions = try JSONDecoder().decode(ServerVideo.self, from: JSONEncoder().encode(portrait))
        check(decodedDimensions == portrait, "list cache retains display dimensions")
        var av1 = portrait; av1.videoCodec = "av1"; av1.frameRate = 60
        let codec = mp4.describeRaw(av1)
        check(codec["videoCodec"] as? String == "av1" && codec["frameRate"] as? Double == 60, "original codec reaches the native decoder selector")
        let cachedCodec = try JSONDecoder().decode(ServerVideo.self, from: JSONEncoder().encode(av1))
        check(cachedCodec == av1, "offline cache retains codec selection")
        let cache = ListCache(provider: "bunkr", epoch: "fixture", revision: 4, videos: [item])
        let restored = try JSONDecoder().decode(ListCache.self, from: JSONEncoder().encode(cache))
        check(restored.videos == [item], "offline list cache retains MP4 metadata")
        var identified = item; identified.fileId = String(repeating: "a", count: 24)
        var renamed = identified; renamed.filename = "A renamed movie.mp4"
        check(identified.key == renamed.key, "rename keeps the list/progress identity")
        check(mp4.mediaURL(identified.filename, fileId: identified.fileId) == mp4.mediaURL(renamed.filename, fileId: renamed.fileId), "rename keeps the byte-range playback URL")
        let delta = ChangeSet(epoch: "fixture", revision: 6, videos: nil, changes: [
            ChangeSet.Change(revision: 5, item: renamed, removed: nil),
            ChangeSet.Change(revision: 6, item: nil, removed: ChangeSet.Removed(filename: identified.filename, type: identified.type)),
        ])
        check(mergingLocalVideos([identified], delta) == [renamed], "rename upsert/removal cannot duplicate or lose the same file")
        let barrier = LocalRevisionBarrier(epoch: "fixture", revision: 6)
        check(!barrier.permits(ChangeSet(epoch: "fixture", revision: 5, videos: [identified], changes: nil)) && barrier.permits(delta), "an older list cannot undo a confirmed rename")
        let normalized = try localMP4Name(" cafe\u{301} ")
        check(normalized == "café.mp4", "local names preserve MP4 and normalize Unicode")
        for invalid in ["", "../outside", "folder/name", ".hidden", String(repeating: "🎬", count: 100)] {
            do { _ = try localMP4Name(invalid); check(false, "unsafe name rejected") } catch { }
        }
        let hls = LocalAPI(server: URL(string: "https://192.168.1.197:9999/videos/fc2")!, provider: "fc2")
        let recording = ServerVideo(filename: "2026-01-01 120000 streamer", type: "original", size: 0, duration: 120, isLive: false)
        let original = hls.describeRaw(recording)
        check(hls.mediaURL(recording.filename).lastPathComponent == "playlist.m3u8", "recording providers retain HLS playback")
        check(original["local"] as? Bool == true && original["membership"] != nil, "recording editing and membership stay enabled")
        print("PASS: local library URL scope, MP4/HLS descriptors, metadata and durable list cache")
    }
}
