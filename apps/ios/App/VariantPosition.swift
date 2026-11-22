import Foundation

// Where playback continues when a recording changes variant (OK, Cut, Return Original).
// OK and Return Original move the same playlist between folders, so the moment stays. A cut
// keeps whole segments in order: a moment inside a kept segment keeps its place in it, and a
// moment in a removed stretch continues at the next kept moment (the last kept second when
// nothing after it was kept).
enum VariantPosition {
    struct Segment: Equatable { let name: String; let start: Double; let end: Double }

    // `time` is on the original playlist's clock; the result on the cut's.
    static func afterCut(_ segments: [Segment], keeping keep: Set<String>, at time: Double) -> Double {
        var kept = 0.0, passed = false
        for segment in segments {
            let length = max(0, segment.end - segment.start), ours = keep.contains(segment.name)
            if !passed && time < segment.end {
                if ours { return kept + min(length, max(0, time - segment.start)) }
                passed = true
            }
            if passed && ours { return kept }
            if ours { kept += length }
        }
        return max(0, kept - 1)
    }
}
