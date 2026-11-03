// Native Foundation benchmark; no phone, networking, media or app data.
import Foundation

@inline(never)
private func previousMigrations(_ current: [ServerVideo], _ next: [ServerVideo]) -> [LocalProgressMigration] {
    next.compactMap { item in
        guard let id = item.fileId,
              current.contains(where: { $0.fileId == nil && $0.filename == item.filename && $0.size == item.size && $0.duration == item.duration }) else { return nil }
        return LocalProgressMigration(filename: item.filename, fileId: id)
    }
}

@main struct LocalLibraryPerformance {
    static func main() throws {
        var results: [[String: Any]] = []
        for count in [1_000, 5_000, 10_000] {
            for mode in ["identified", "mixed-legacy", "no-file-ids"] {
                let legacy = mode == "mixed-legacy", noIDs = mode == "no-file-ids"
                let current = (0..<count).map { index in
                    ServerVideo(filename: "Video \(index).mkv", type: "original", size: Double(index * 1_000_000),
                                duration: Double(index % 100 + 10), isLive: false,
                                fileId: noIDs || (legacy && index % 10 == 0) ? nil : "id-\(index)")
                }
                let next = current.enumerated().map { index, row -> ServerVideo in
                    var row = row; row.fileId = noIDs ? nil : "id-\(index)"; return row
                }
                let expected = previousMigrations(current, next)
                precondition(localProgressMigrations(from: current, to: next) == expected)
                for indexed in [false, true] {
                    var times: [Double] = []
                    for _ in 0..<3 {
                        let started = ProcessInfo.processInfo.systemUptime
                        let migrations = indexed ? localProgressMigrations(from: current, to: next) : previousMigrations(current, next)
                        let milliseconds = (ProcessInfo.processInfo.systemUptime - started) * 1_000
                        precondition(migrations == expected)
                        times.append(milliseconds)
                    }
                    results.append(["rows": count, "mode": mode, "legacyRows": noIDs ? count : legacy ? count / 10 : 0,
                                    "implementation": indexed ? "indexed" : "previous",
                                    "medianMs": times.sorted()[1], "runsMs": times, "migrations": expected.count])
                }
            }
        }
        let report: [String: Any] = ["scope": "Optimized native Mac Foundation migration calculation only; synthetic libraries, no claim about total playback performance",
                                     "results": results]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]))
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}
