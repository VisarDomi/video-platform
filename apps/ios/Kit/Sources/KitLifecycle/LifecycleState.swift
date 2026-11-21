import Foundation

public struct LifecycleState: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case launching, active, inactive, background }
    public enum Event: Sendable { case resign, background, activate }
    public enum Effect: Sendable, Equatable { case save, pause, resume(afterBackground: Bool) }
    public private(set) var activation: UInt64 = 0
    public private(set) var phase: Phase
    public init(_ phase: Phase = .launching) { self.phase = phase }
    public mutating func receive(_ event: Event) -> [Effect] {
        switch (phase, event) {
        case (.active, .resign), (.launching, .resign): phase = .inactive; return [.save]
        case (.active, .background), (.launching, .background): phase = .background; return [.save, .pause]
        case (.inactive, .background): phase = .background; return [.pause]
        case (.background, .activate): activation &+= 1; phase = .active; return [.resume(afterBackground: true)]
        case (.launching, .activate), (.inactive, .activate): activation &+= 1; phase = .active; return [.resume(afterBackground: false)]
        default: return []
        }
    }
}

public struct TransferOwnership: Sendable, Equatable {
    public enum Phase: Sendable, Equatable {
        case foreground, handingOff(UInt64), background(UInt64), reclaiming(UInt64)
    }
    public private(set) var phase: Phase = .foreground
    private var generation: UInt64 = 0
    public init() {}
    public mutating func handOff() -> UInt64 { generation &+= 1; phase = .handingOff(generation); return generation }
    public mutating func reclaim() -> UInt64 { generation &+= 1; phase = .reclaiming(generation); return generation }
    public func ownsHandoff(_ id: UInt64) -> Bool { phase == .handingOff(id) }
    public func ownsReclaim(_ id: UInt64) -> Bool { phase == .reclaiming(id) }
    @discardableResult public mutating func handedOff(_ id: UInt64) -> Bool {
        guard ownsHandoff(id) else { return false }; phase = .background(id); return true
    }
    @discardableResult public mutating func reclaimed(_ id: UInt64) -> Bool {
        guard ownsReclaim(id) else { return false }; phase = .foreground; return true
    }
}
