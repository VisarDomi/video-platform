import Foundation

struct ViewerInteractionState: Equatable {
    enum Motion { case rest, contact, dragging, decelerating }
    enum Zoom { case minimum, pinching, magnified }
    private(set) var motion = Motion.rest
    private(set) var zoom = Zoom.minimum
    var touching: Bool { motion == .contact || motion == .dragging }
    var scrolling: Bool { motion == .dragging || motion == .decelerating }
    var zoomed: Bool { zoom != .minimum }
    var revealsNeighbors: Bool { scrolling && !zoomed }
    mutating func contact(_ down: Bool) {
        if down && motion != .dragging { motion = .contact }
        else if !down && motion == .contact { motion = .rest }
    }
    mutating func drag() { guard !zoomed else { return }; motion = .dragging }
    mutating func dragEnded(decelerating: Bool) { motion = decelerating ? .decelerating : .rest }
    mutating func settle() { motion = .rest }
    mutating func pinch() { zoom = .pinching; motion = .rest }
    mutating func magnify() { zoom = .magnified }
    mutating func unzoom() { zoom = .minimum }
}

struct ViewerPresentationState: Equatable {
    enum Phase { case prepared, loading, revealed, closed }
    private(set) var phase = Phase.prepared
    var closed: Bool { phase == .closed }
    var revealed: Bool { phase == .revealed }
    mutating func open() { guard !closed else { return }; phase = .loading }
    @discardableResult mutating func reveal() -> Bool {
        guard !closed && !revealed else { return false }; phase = .revealed; return true
    }
    @discardableResult mutating func close() -> Bool {
        guard !closed else { return false }; phase = .closed; return true
    }
}
