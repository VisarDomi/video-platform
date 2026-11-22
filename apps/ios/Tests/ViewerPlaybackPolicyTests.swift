import Foundation

@main
struct ViewerPlaybackPolicyTests {
    static func main() {
        func check(_ condition: Bool, _ label: String) { if !condition { print("FAIL:", label); exit(1) } }
        let live = ViewerPlaybackPolicy(live: true)
        check((0..<3).allSatisfy { live.shouldPlay(position: $0, inBackground: false) }, "live neighbours keep playing muted in the foreground")
        check((0..<3).map { live.shouldPlay(position: $0, inBackground: true) } == [false, true, false], "live neighbours wait in the background")
        check(live.forwardBuffer(parked: false) == 0 && live.forwardBuffer(parked: true) == 0, "live buffering stays AVPlayer's")
        let vod = ViewerPlaybackPolicy(live: false)
        for background in [false, true] {
            check((0..<3).map { vod.shouldPlay(position: $0, inBackground: background) } == [false, true, false], "VOD neighbours pause")
        }
        check(vod.forwardBuffer(parked: false) == 0, "the watched video, and the user's pause, keep AVPlayer's own buffering")
        // AVPlayer treats a preference below a segment as automatic: 0.5 let hidden neighbours
        // download tens of megabytes each. Two seconds is honoured.
        check(vod.forwardBuffer(parked: true) >= 2, "a parked neighbour asks for at least one HLS segment")
        check(vod.neighboursWaitForStart && live.neighboursWaitForStart, "neighbours load after the current video starts")
        print("PASS: shared playback policy (live neighbours play, VOD neighbours park with an honoured buffer, start first)")
    }
}
