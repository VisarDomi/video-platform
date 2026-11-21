import Foundation

// Exactly one backend seek runs. New requests replace the waiting target;
// completions from cancelled/replaced media cannot finish a newer seek.
struct ChasingSeek: Equatable {
    struct Request: Equatable { let id: UInt64; let target: Double }
    enum Phase: Equatable { case idle, waiting(Request), running(Request, latest: Request) }
    enum Completion: Equatable { case ignored, retry, settled(Double) }
    private(set) var phase = Phase.idle
    private var generation: UInt64 = 0
    var target: Double? {
        switch phase { case .idle: return nil; case .waiting(let request): return request.target; case .running(_, let latest): return latest.target }
    }
    var isInFlight: Bool { if case .running = phase { return true }; return false }
    mutating func request(_ seconds: Double) {
        guard seconds.isFinite else { return }
        if target == seconds { return }
        generation &+= 1
        let request = Request(id: generation, target: seconds)
        if case .running(let current, _) = phase { phase = .running(current, latest: request) }
        else { phase = .waiting(request) }
    }
    mutating func begin() -> Request? {
        guard case .waiting(let request) = phase else { return nil }
        phase = .running(request, latest: request); return request
    }
    mutating func complete(_ request: Request) -> Completion {
        guard case .running(let current, let latest) = phase, current.id == request.id else { return .ignored }
        if latest.id != current.id { phase = .waiting(latest); return .retry }
        phase = .idle; return .settled(request.target)
    }
    mutating func rejected(_ request: Request) {
        guard case .running(let current, let latest) = phase, current.id == request.id else { return }
        phase = .waiting(latest)
    }
    mutating func cancel() { generation &+= 1; phase = .idle }
}
