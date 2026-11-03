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
        check(localProgressMigrations(from: [item], to: [item]).isEmpty, "HLS catalogs without stable file IDs skip migration")
        check(localProgressMigrations(from: restored.videos, to: [identified]) == [LocalProgressMigration(filename: filename, fileId: identified.fileId!)], "old filename progress migrates to the stable file identity")
        check(localProgressMigrations(from: [identified], to: [identified]).isEmpty, "identified caches have no legacy migration work")
        var changedBytes = identified; changedBytes.size += 1
        var changedDuration = identified; changedDuration.duration += 1
        check(localProgressMigrations(from: [item], to: [changedBytes, changedDuration, item]).isEmpty, "different content and missing new identities do not inherit progress")
        var editedIdentity = identified; editedIdentity.type = "edited"
        check(localProgressMigrations(from: [item, item], to: [identified, editedIdentity]) == [identified, editedIdentity].map { LocalProgressMigration(filename: $0.filename, fileId: $0.fileId!) }, "variants retain the old filename migration contract without duplicate matches")
        // Compare against the previous migration rule across mixed old/new caches,
        // additions, removals, duplicate filenames and metadata replacements.
        for seed in 0..<50 {
            let prior = (0..<120).map { index -> ServerVideo in
                var row = item
                row.filename = "Video \((index + seed) % 40).mp4"
                row.size = Double(index % 11); row.duration = Double((index + seed) % 7)
                row.fileId = (index + seed) % 3 == 0 ? nil : "id-\(index)"
                return row
            }
            let next = prior.enumerated().compactMap { index, row -> ServerVideo? in
                guard (index + seed) % 5 != 0 else { return nil }
                var updated = row; updated.fileId = "stable-\(index)"
                if (index + seed) % 4 == 0 { updated.duration += 1 }
                return updated
            }
            let expected = next.compactMap { row -> LocalProgressMigration? in
                guard let id = row.fileId, prior.contains(where: { $0.fileId == nil && $0.filename == row.filename && $0.size == row.size && $0.duration == row.duration }) else { return nil }
                return LocalProgressMigration(filename: row.filename, fileId: id)
            }
            check(localProgressMigrations(from: prior, to: next) == expected, "indexed migrations preserve the previous matching rule")
        }
        var renamed = identified; renamed.filename = "A renamed movie.mp4"
        check(localProgressMigrations(from: [item], to: [renamed]).isEmpty, "an unrelated renamed file does not take filename progress")
        check(identified.key == renamed.key, "rename keeps the list/progress identity")
        check(mp4.mediaURL(identified.filename, fileId: identified.fileId) == mp4.mediaURL(renamed.filename, fileId: renamed.fileId), "rename keeps the byte-range playback URL")
        let originalFiles = LocalAPI(server: mp4.server, provider: "bunkr", mediaKind: .file)
        check(originalFiles.mediaURL(identified.filename, fileId: identified.fileId) == mp4.mediaURL(identified.filename, fileId: identified.fileId), "original-file mode preserves legacy MP4 playback addresses")
        for fileExtension in ["mkv", "webm"] {
            var video = identified; video.filename = "Original." + fileExtension
            let description = originalFiles.describeRaw(video)
            check((description["media"] as? [String: String])?["kind"] == "file", "non-MP4 originals retain a generic file source")
            let renamed = try localMP4Name("New title", extension: fileExtension)
            check(renamed == "New title." + fileExtension, "rename preserves the source container")
        }
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
