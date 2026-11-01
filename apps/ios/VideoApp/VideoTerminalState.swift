import Foundation

// libvlc 4 reports stopped for both EOF and failed inputs. Its cached clock is
// sampled, so classify the final position within the bounded reporting interval,
// and never turn an observed input error into a successful completion.
enum VideoTerminalState {
    static let clockPeriod = 0.1
    // The stop event can follow the last native time point by about a second,
    // even with a shorter requested notification period (observed on iOS).
    static let maximumClockTail = 2.0

    static func reachedEnd(duration: Double, time: Double, position: Double, inputFailed: Bool) -> Bool {
        guard !inputFailed, duration.isFinite, duration > 0, time.isFinite,
              position.isFinite, time > 0, position > 0 else { return false }
        let tail = min(maximumClockTail, duration / 2)
        return time >= duration - tail && position >= 1 - tail / duration
    }
}
