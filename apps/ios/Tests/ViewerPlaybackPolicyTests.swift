import Foundation

@main
struct ViewerPlaybackPolicyTests {
    static func main() {
        func check(_ condition: Bool, _ label: String) { if !condition { print("FAIL:", label); exit(1) } }
        let bunkr = ViewerPlaybackPolicy(provider: "bunkr")
        for background in [false, true] {
            check((0..<3).map { bunkr.shouldPlay(position: $0, inBackground: background) } == [false, true, false], "Bunkr has only one running decoder in foreground and background")
        }
        check(!bunkr.waitsToMinimizeStalling, "LAN startup does not wait for the automatic network buffer heuristic")
        check(bunkr.forwardBuffer(playing: true) == 2 && bunkr.forwardBuffer(playing: false) == 0.5, "active and paused preview buffers are bounded separately")
        check(bunkr.resumesBufferedPlayback(requested: true, hasData: true, ended: false, seeking: false), "selected playback recovers after a LAN buffer underrun")
        check(!bunkr.resumesBufferedPlayback(requested: false, hasData: true, ended: false, seeking: false), "buffer recovery cannot undo a user pause or start a neighbour")
        check(!bunkr.resumesBufferedPlayback(requested: true, hasData: false, ended: false, seeking: false), "empty-buffer events cannot spin playback retries")
        check(!bunkr.resumesBufferedPlayback(requested: true, hasData: true, ended: true, seeking: false), "a completed movie stays completed")
        check(!bunkr.resumesBufferedPlayback(requested: true, hasData: true, ended: false, seeking: true), "buffer events cannot race an exact seek")
        for provider in ["tango", "fc2", "sc", "vault", "tango-live"] {
            let existing = ViewerPlaybackPolicy(provider: provider)
            check((0..<3).allSatisfy { existing.shouldPlay(position: $0, inBackground: false) }, "existing providers retain foreground previews")
            check((0..<3).map { existing.shouldPlay(position: $0, inBackground: true) } == [false, true, false], "existing providers pause background neighbours")
            check(existing.waitsToMinimizeStalling && existing.forwardBuffer(playing: true) == 0, "existing provider buffering remains system-managed")
        }
        print("PASS: Bunkr single-player LAN policy, paused preview buffers and provider lifecycle behavior")
    }
}
