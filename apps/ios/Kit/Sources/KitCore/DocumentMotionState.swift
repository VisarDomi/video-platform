import Foundation

// Contact, scrolling and pinching overlap; they are orthogonal axes, not three
// flags whose reset order depends on UIKit callback order.
public struct DocumentMotionState: Sendable, Equatable {
    public enum Contact: Sendable { case up, down }
    public enum Scroll: Sendable { case rest, dragging, decelerating }
    public enum Pinch: Sendable { case rest, pinching }
    public private(set) var contact = Contact.up
    public private(set) var scroll = Scroll.rest
    public private(set) var pinch = Pinch.rest
    public init() {}
    public var touching: Bool { contact == .down }
    public var scrolling: Bool { scroll != .rest }
    public var pinching: Bool { pinch == .pinching }
    public mutating func touch(_ down: Bool) { contact = down ? .down : .up }
    public mutating func drag() { scroll = .dragging }
    public mutating func dragEnded(decelerating: Bool) { scroll = decelerating ? .decelerating : .rest }
    public mutating func settleScroll() { scroll = .rest }
    public mutating func beginPinch() { pinch = .pinching }
    public mutating func endPinch() { pinch = .rest }
}
