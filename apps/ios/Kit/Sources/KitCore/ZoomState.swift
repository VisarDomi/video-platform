import Foundation

// The document point at the viewport's centre, independent of its pixel size.
public struct ZoomState: Codable, Sendable, Equatable {
    public var scale: Double
    public var x: Double
    public var y: Double

    public init(scale: Double, x: Double = 0.5, y: Double = 0.5) {
        self.scale = min(max(scale.isFinite ? scale : 1, 1), 100)
        self.x = min(max(x.isFinite ? x : 0.5, 0), 1)
        self.y = min(max(y.isFinite ? y : 0.5, 0), 1)
    }
}
