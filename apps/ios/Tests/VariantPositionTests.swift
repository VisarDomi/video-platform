import Foundation

@main
struct VariantPositionTests {
    static func main() {
        func check(_ condition: Bool, _ label: String) { if !condition { print("FAIL:", label); exit(1) } }
        let segments = (0..<10).map { VariantPosition.Segment(name: "\($0).ts", start: Double($0) * 2, end: Double($0 + 1) * 2) }
        // Kept: 0-1 (0..4 s), removed 2-5 (4..12 s), kept 6-7 (12..16 s), removed 8-9.
        let keep: Set<String> = ["0.ts", "1.ts", "6.ts", "7.ts"]
        check(VariantPosition.afterCut(segments, keeping: keep, at: 3.5) == 3.5, "a moment before any removal keeps its time")
        check(VariantPosition.afterCut(segments, keeping: keep, at: 13) == 5, "a kept moment after a removal moves up by the removed length")
        check(VariantPosition.afterCut(segments, keeping: keep, at: 7) == 4, "a removed moment continues at the next kept moment")
        check(VariantPosition.afterCut(segments, keeping: keep, at: 18) == 7, "after the last kept segment: its last second")
        check(VariantPosition.afterCut(segments, keeping: ["4.ts"], at: 1) == 0, "removed opening: the first kept moment")
        check(VariantPosition.afterCut(segments, keeping: Set(segments.map(\.name)), at: 11.25) == 11.25, "keeping everything keeps the moment")
        print("PASS: a cut keeps the watched moment (kept place, next kept moment, last kept second)")
    }
}
