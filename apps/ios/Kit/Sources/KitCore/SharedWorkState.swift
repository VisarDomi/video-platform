import Foundation

// One transfer can have visible and speculative owners. Cancelling one owner
// revokes only that lease; execution is cancelled when the final lease leaves.
public struct SharedWorkState: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case accepting(Set<UUID>), completed, cancelled }
    public let id: UUID
    public private(set) var phase: Phase = .accepting([])
    public init(id: UUID = UUID()) { self.id = id }
    public mutating func join() -> UUID? {
        guard case .accepting(var owners) = phase else { return nil }
        let caller = UUID(); owners.insert(caller); phase = .accepting(owners); return caller
    }
    @discardableResult public mutating func leave(_ caller: UUID) -> Bool {
        guard case .accepting(var owners) = phase else { return false }
        guard owners.remove(caller) != nil else { return false }
        phase = owners.isEmpty ? .cancelled : .accepting(owners)
        return owners.isEmpty
    }
    @discardableResult public mutating func finish() -> Bool {
        guard case .accepting = phase else { return false }; phase = .completed; return true
    }
    public mutating func cancel() { phase = .cancelled }
}
