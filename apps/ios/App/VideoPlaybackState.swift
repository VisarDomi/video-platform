import Foundation

// Media readiness, user intent and user actions are independent. Backend callbacks
// observe readiness; only a current user action may resume a completed seek.
struct VideoPlaybackState: Equatable {
    enum Phase: Equatable { case empty, resolving, preparing, ready, recovering(wasReady: Bool), ended, failed(wasReady: Bool) }
    enum Intent { case paused, playing }
    private(set) var phase = Phase.empty
    private(set) var intent = Intent.paused
    private var action: UInt64 = 0
    var requested: Bool { intent == .playing }
    var canPlay: Bool { requested && phase != .empty && phase != .ended }
    var started: Bool {
        switch phase {
        case .ready, .ended: return true
        case .recovering(let ready), .failed(let ready): return ready
        default: return false
        }
    }
    mutating func load(play: Bool) { action &+= 1; phase = .resolving; intent = play ? .playing : .paused }
    mutating func resolved() { if phase == .resolving { phase = .preparing } }
    mutating func ready() { if phase != .empty && phase != .ended { phase = .ready } }
    mutating func clear() { action &+= 1; phase = .empty; intent = .paused }
    @discardableResult mutating func play() -> Bool {
        guard phase != .empty && phase != .ended else { return false }
        action &+= 1; intent = .playing; return true
    }
    mutating func pause() { action &+= 1; intent = .paused }
    @discardableResult mutating func recover() -> Bool {
        guard phase != .empty && phase != .ended else { return false }
        phase = .recovering(wasReady: started); return true
    }
    mutating func end() {
        guard phase != .empty && phase != .ended else { return }
        action &+= 1; phase = .ended
    }
    mutating func fail() {
        guard phase != .empty && phase != .ended else { return }
        phase = .failed(wasReady: started)
    }
    func acceptsEnd(seeking: Bool, current: Double, duration: Double) -> Bool {
        guard phase != .empty, !seeking else { return false }
        switch phase { case .recovering, .failed: return false; default: break }
        // The item can deliver its old EOF after a seek back into the video.
        return !(duration.isFinite && duration > 0 && current.isFinite && current < duration - 0.1)
    }
    mutating func seek(resume: Bool?, beforeEnd: Bool) -> UInt64 {
        action &+= 1
        if phase == .ended && beforeEnd { phase = .ready }
        if let resume { intent = resume ? .playing : .paused }
        return action
    }
    func mayResumeSeek(_ ticket: UInt64) -> Bool { ticket == action && canPlay }
}

// The selected video's explicit user intent survives foregrounding, audio
// interruptions and list refreshes. Neighbour policy and selecting a new video
// are separate events; a lifecycle callback is never a user Play command.
struct ViewerPlaybackIntent {
    private(set) var intent = VideoPlaybackState.Intent.playing
    var wantsPlay: Bool { intent == .playing }
    mutating func select() { intent = .playing }
    mutating func request(_ intent: VideoPlaybackState.Intent) { self.intent = intent }
    func allows(current: Bool, policy: Bool) -> Bool { policy && (!current || wantsPlay) }
}
