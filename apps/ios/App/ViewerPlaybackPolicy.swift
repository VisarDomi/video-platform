import Foundation

// How a video plays beside its neighbours. Live streams keep playing muted while they are
// neighbours; recordings and other VOD park theirs: paused at the saved position with a short
// buffer. An app with its own engine (an override folder) brings its own policy.
struct ViewerPlaybackPolicy: Equatable {
    let live: Bool
    var playsNeighbors: Bool { live }
    // Neighbours load once the current video plays, so their playlists and first segments never
    // compete with its start (measured on local recordings: 2.2 s to playback became 0.3-0.8 s).
    var neighboursWaitForStart: Bool { true }
    func shouldPlay(position: Int, inBackground: Bool) -> Bool {
        position == 1 || (playsNeighbors && !inBackground)
    }
    // A parked neighbour asks for two seconds ahead. AVPlayer treats a preference below a
    // segment as automatic: at 0.5 s every hidden neighbour downloaded 15-30 MB within seconds
    // of opening, beside the video being watched and its seeks. Everything else buffers as
    // AVPlayer chooses.
    func forwardBuffer(parked: Bool) -> Double { parked && !playsNeighbors ? 2 : 0 }
}
