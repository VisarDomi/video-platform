import Foundation

// Field evidence of playback for an engine still being measured on the phone. The shared
// engine keeps none; an app with its own engine (an override folder) records it.
@MainActor
enum PlaybackEvidence {
    // `last`: when this viewer last recorded, for the override's cadence.
    static func record(_ units: [ViewerUnit], moving: Bool, last: inout CFTimeInterval) {}
}
