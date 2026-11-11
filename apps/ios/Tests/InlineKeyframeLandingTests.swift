import Foundation

@main
struct InlineKeyframeLandingTests {
    static func main() {
        func check(_ condition: Bool, _ label: String) { if !condition { print("FAIL:", label); exit(1) } }
        typealias Landing = InlineKeyframeLanding.Landing
        func land(_ target: Double, from origin: Double, _ keys: [Double], complete: Bool = true, fast: Bool = true) -> Landing {
            InlineKeyframeLanding.landing(target: target, origin: origin, keyframes: keys, indexComplete: complete, decodesFast: fast)
        }
        // The library's shape: a keyframe every 4 to 7 s at 60 pictures a second.
        let keys = [0, 4.17, 8.34, 12.51, 16.68, 20.85, 25.02]
        check(land(19, from: 2, keys) == .keyframe(16.68), "a forward seek shows the last keyframe at or before the target")
        check(land(16.68, from: 2, keys) == .keyframe(16.68), "a target on a keyframe lands on it")
        check(land(3, from: 19, keys) == .keyframe(0), "a backward seek shows the keyframe at or before the target")
        check(land(9, from: 19, keys) == .keyframe(8.34), "a backward seek never lands after its target")
        check(land(30, from: 2, keys) == .keyframe(25.02), "the last group of pictures is reached through its keyframe")
        check(land(-1, from: 5, [1, 5, 9]) == .keyframe(1), "before the first keyframe there is only the first")
        // Inside the origin's own group of pictures there is no keyframe to show.
        check(land(7, from: 5, keys) == .exact, "a hardware decoder reaches a short forward move exactly")
        check(land(5.5, from: 5, keys, fast: false) == .stay, "a software decoder keeps its picture for a move it cannot beat by playing on")
        check(land(7.5, from: 5, keys, fast: false) == .keyframe(8.34), "past the midpoint the next keyframe is the nearest picture")
        check(land(26, from: 25.5, keys, fast: false) == .stay, "the last group has no next keyframe to jump to")
        check(land(5, from: 5, keys) == .stay && land(5.1, from: 5, keys) == .stay, "a drag's first touch sample moves nothing")
        check(land(19, from: 20, keys) == .exact, "a hardware decoder reaches a short backward move exactly")
        check(land(19.5, from: 20, keys, fast: false) == .stay, "a software decoder keeps its picture for a short backward move")
        check(land(17.5, from: 20, keys, fast: false) == .keyframe(16.68), "nearer to its keyframe than to the origin, a backward move shows the keyframe")
        check(land(15, from: 20, keys, fast: false) == .keyframe(12.51), "an earlier group of pictures is shown by its keyframe")
        // A drag is many seeks from one origin: its pictures only move with the finger.
        var shown: [Double] = []
        for step in 0...60 {
            if case .keyframe(let key) = land(5 + Double(step) * 0.3, from: 5, keys, fast: false) { shown.append(key) }
        }
        check(shown == shown.sorted() && shown.first == 8.34 && shown.last == 20.85 && shown.allSatisfy { $0 > 5 }, "a forward drag never shows an earlier picture")
        shown = []
        for step in 0...60 {
            if case .keyframe(let key) = land(23 - Double(step) * 0.3, from: 23, keys, fast: false) { shown.append(key) }
        }
        check(shown == shown.sorted(by: >) && shown.first == 20.85 && shown.last == 4.17 && shown.allSatisfy { $0 < 23 }, "a backward drag never shows a later picture")
        // Matroska before its Cues are read: the index ends where reading has got to.
        check(land(300, from: 2, [0, 5.9], complete: false) == .exact, "an index that ends before the target is not trusted")
        check(land(4, from: 20, [0, 5.9, 11.8], complete: false) == .keyframe(0), "a target inside the read part of the index lands on its keyframe")
        check(land(10, from: 2, []) == .exact, "a source without an index seeks exactly")
        check(InlineKeyframeLanding.start(target: 97.3, keyframes: [91.74, 95.91, 100.08]) == 95.91, "a saved position starts on its keyframe")
        check(InlineKeyframeLanding.start(target: 0.5, keyframes: [1, 5]) == nil, "a position before every keyframe keeps the reposition's own landing")
        print("PASS: keyframe landings for seeks, drags, partial indexes and saved positions")
    }
}
