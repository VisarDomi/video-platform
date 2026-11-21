import Foundation

struct DecoderLifecycle: Equatable {
    enum Phase: Equatable { case opening, ready, ended, failed(wasReady: Bool), stopping, stopped }
    enum Intent { case paused, playing }
    private(set) var phase = Phase.opening
    private(set) var intent = Intent.paused
    var requested: Bool { intent == .playing }
    var opened: Bool {
        switch phase { case .ready, .ended: return true; case .failed(let ready): return ready; default: return false }
    }
    var terminal: Bool { phase == .ended }
    var stopping: Bool { phase == .stopping || phase == .stopped }
    var failed: Bool { if case .failed = phase { return true }; return false }
    @discardableResult mutating func play() -> Bool {
        guard !terminal && !stopping else { return false }; intent = .playing; return true
    }
    mutating func pause() { intent = .paused }
    @discardableResult mutating func openedInput() -> Bool {
        guard !terminal && !stopping else { return false }; phase = .ready; return true
    }
    @discardableResult mutating func observedPause() -> Bool {
        // A late pause after an input error is not evidence that it recovered.
        // Only an actual ready/playing input may clear the failure.
        guard !failed else { return false }; return openedInput()
    }
    mutating func fail() { guard !terminal && !stopping else { return }; phase = .failed(wasReady: opened) }
    mutating func end() { guard !failed && !stopping else { return }; phase = .ended; intent = .paused }
    mutating func seek() { if terminal { phase = .ready } }
    @discardableResult mutating func stop() -> Bool {
        guard !stopping else { return false }; phase = .stopping; intent = .paused; return true
    }
    mutating func retired() { if stopping { phase = .stopped } }
}

enum VideoOutputState: Equatable {
    case enabled, disabled, awaitingForeground
    var requested: Bool { self != .disabled }
    var needsRestore: Bool { self == .awaitingForeground }
    mutating func request(_ enabled: Bool) {
        if !enabled { self = .disabled }
        else if self == .disabled { self = .awaitingForeground }
    }
    mutating func restored() { if self == .awaitingForeground { self = .enabled } }
}
