import Foundation

// The LAN MP4 library needs one running decoder, not three simultaneous 4K streams.
// Existing live/recording providers keep their established neighbouring-video behavior.
struct ViewerPlaybackPolicy: Equatable {
    let provider: String
    var playsNeighbors: Bool { provider != "bunkr" }
    var waitsToMinimizeStalling: Bool { provider != "bunkr" }
    func shouldPlay(position: Int, inBackground: Bool) -> Bool {
        position == 1 || (playsNeighbors && !inBackground)
    }
    func forwardBuffer(playing: Bool) -> Double {
        provider == "bunkr" ? (playing ? 2 : 0.5) : 0
    }
    func resumesBufferedPlayback(requested: Bool, hasData: Bool, ended: Bool, seeking: Bool) -> Bool {
        !waitsToMinimizeStalling && requested && hasData && !ended && !seeking
    }
}
