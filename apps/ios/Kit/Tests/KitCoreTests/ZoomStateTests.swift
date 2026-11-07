import Foundation
import Testing
@testable import KitCore

@Test func zoomStateKeepsTheExactDocumentPointAcrossSerialization() throws {
    let state = ZoomState(scale: 2.375, x: 0.6738123456789, y: 0.3178123456789)
    let restored = try JSONDecoder().decode(ZoomState.self, from: JSONEncoder().encode(state))
    #expect(restored == state)
    let width = 428.0, height = 926.0
    #expect(abs((restored.x * width * restored.scale - width / 2) - (state.x * width * state.scale - width / 2)) < 0.000001)
    #expect(abs((restored.y * height * restored.scale - height / 2) - (state.y * height * state.scale - height / 2)) < 0.000001)
}
