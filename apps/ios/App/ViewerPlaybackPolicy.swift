import Foundation

// A library of original files needs one running decoder, not three simultaneous 4K streams;
// live streams keep their neighbours playing (ProviderTraits).
struct ViewerPlaybackPolicy: Equatable {
    let provider: String
    var playsNeighbors: Bool { ProviderTraits.live.contains(provider) }
    var waitsToMinimizeStalling: Bool { !ProviderTraits.originalFiles.contains(provider) }
    func shouldPlay(position: Int, inBackground: Bool) -> Bool {
        position == 1 || (playsNeighbors && !inBackground)
    }
    func forwardBuffer(playing: Bool) -> Double {
        !playsNeighbors ? (playing ? (ProviderTraits.originalFiles.contains(provider) ? 2 : 0) : 0.5) : 0
    }
    func resumesBufferedPlayback(requested: Bool, hasData: Bool, ended: Bool, seeking: Bool) -> Bool {
        !waitsToMinimizeStalling && requested && hasData && !ended && !seeking
    }
}
