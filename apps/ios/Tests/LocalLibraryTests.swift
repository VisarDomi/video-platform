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
        let cache = ListCache(provider: "bunkr", epoch: "fixture", revision: 4, videos: [item])
        let restored = try JSONDecoder().decode(ListCache.self, from: JSONEncoder().encode(cache))
        check(restored.videos == [item], "offline list cache retains MP4 metadata")
        let hls = LocalAPI(server: URL(string: "https://192.168.1.197:9999/videos/fc2")!, provider: "fc2")
        let recording = ServerVideo(filename: "2026-01-01 120000 streamer", type: "original", size: 0, duration: 120, isLive: false)
        let original = hls.describeRaw(recording)
        check(hls.mediaURL(recording.filename).lastPathComponent == "playlist.m3u8", "recording providers retain HLS playback")
        check(original["local"] as? Bool == true && original["membership"] != nil, "recording editing and membership stay enabled")
        print("PASS: local library URL scope, MP4/HLS descriptors, metadata and durable list cache")
    }
}
