import Foundation

// Task handles own execution; this value owns permission to publish its result.
// Cancellation immediately revokes that permission, even before the task returns.
public struct OperationState: Sendable, Equatable {
    public struct ID: Hashable, Sendable { private let value = UUID(); public init() {} }
    public enum Phase: Sendable, Equatable { case idle, running(ID), finished(ID) }
    public private(set) var phase: Phase = .idle
    public init() {}
    public var isRunning: Bool { if case .running = phase { return true }; return false }
    @discardableResult public mutating func begin() -> ID { let id = ID(); phase = .running(id); return id }
    public func owns(_ id: ID) -> Bool { phase == .running(id) || phase == .finished(id) }
    @discardableResult public mutating func finish(_ id: ID) -> Bool {
        guard phase == .running(id) else { return false }; phase = .finished(id); return true
    }
    public mutating func cancel() { phase = .idle }
}

// A request while running asks for another pass; it never starts a second worker.
public struct CoalescedWork: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case idle, scheduled, running(pending: Bool) }
    public private(set) var phase: Phase = .idle
    public init() {}
    public var isRunning: Bool { if case .running = phase { return true }; return false }
    public var isPending: Bool { if case .running(let pending) = phase { return pending }; return phase == .scheduled }
    @discardableResult public mutating func request() -> Bool {
        switch phase {
        case .idle: phase = .scheduled; return true
        case .scheduled: return false
        case .running: phase = .running(pending: true); return false
        }
    }
    @discardableResult public mutating func begin() -> Bool {
        guard !isRunning else { _ = request(); return false }
        phase = .running(pending: false); return true
    }
    public mutating func consumePending() { if isRunning { phase = .running(pending: false) } }
    @discardableResult public mutating func finish() -> Bool {
        let pending = isPending; phase = pending ? .scheduled : .idle; return pending
    }
}
