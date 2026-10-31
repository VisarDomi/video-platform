import Foundation
import KitCore

// Bounded, local-only playback evidence; no URLs, cookies or media pictures.
@MainActor
enum BunkrPlaybackDiagnostics {
    private static var samples: [[String: Any]] = []
    private static var registered = false
    static func record(_ units: [[String: Any]]) {
        if !registered {
            registered = true
            DebugState.shared.register("bunkrPlayback") { ["samples": samples] }
        }
        samples.append(["at": Date().timeIntervalSince1970, "units": units])
        if samples.count > 12 { samples.removeFirst(samples.count - 12) }
    }
}
