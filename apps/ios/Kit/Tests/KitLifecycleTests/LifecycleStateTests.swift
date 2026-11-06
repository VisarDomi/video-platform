import XCTest
@testable import KitLifecycle

final class LifecycleStateTests: XCTestCase {
    func testTransientInactiveAndBackgroundAreDistinctAndDuplicateEventsAreIdempotent() {
        var state = LifecycleState(.active)
        XCTAssertEqual(state.receive(.resign), [.save])
        XCTAssertEqual(state.receive(.resign), [])
        XCTAssertEqual(state.receive(.activate), [.resume(afterBackground: false)])
        XCTAssertEqual(state.receive(.activate), [])
        XCTAssertEqual(state.receive(.background), [.save, .pause])
        XCTAssertEqual(state.phase, .background)
        XCTAssertEqual(state.receive(.background), [])
        XCTAssertEqual(state.receive(.activate), [.resume(afterBackground: true)])
    }
    func testNewActivationRevokesQueuedSaveWorkFromThePreviousVisit() {
        var state = LifecycleState(.active)
        _ = state.receive(.resign); let old = state.activation
        _ = state.receive(.activate); _ = state.receive(.resign)
        XCTAssertNotEqual(state.activation, old)
    }
    func testLateHandoffAndReclaimCannotOvertakeTheNewOwner() {
        var state = TransferOwnership()
        let old = state.handOff(), reclaim = state.reclaim()
        XCTAssertFalse(state.handedOff(old))
        let next = state.handOff()
        XCTAssertFalse(state.reclaimed(reclaim))
        XCTAssertTrue(state.handedOff(next))
        let foreground = state.reclaim()
        XCTAssertTrue(state.reclaimed(foreground)); XCTAssertEqual(state.phase, .foreground)
    }
}
