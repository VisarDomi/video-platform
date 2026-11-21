import XCTest
@testable import KitCore

final class OperationStateTests: XCTestCase {
    func testSupersededAndCancelledWorkCannotPublishOrClearItsReplacement() {
        var state = OperationState()
        let first = state.begin(), second = state.begin()
        XCTAssertFalse(state.owns(first)); XCTAssertFalse(state.finish(first))
        XCTAssertTrue(state.owns(second)); XCTAssertTrue(state.finish(second))
        XCTAssertFalse(state.finish(second))
        state.cancel(); XCTAssertFalse(state.owns(second))
    }
    func testConcurrentRequestsCoalesceWithoutLosingTheLastPass() {
        var state = CoalescedWork()
        XCTAssertTrue(state.request()); XCTAssertFalse(state.request())
        XCTAssertTrue(state.begin())
        for _ in 0..<100 { XCTAssertFalse(state.request()) }
        XCTAssertTrue(state.isPending)
        state.consumePending(); XCTAssertFalse(state.isPending)
        XCTAssertFalse(state.finish()); XCTAssertEqual(state.phase, .idle)
    }
}

final class SharedWorkStateTests: XCTestCase {
    func testCancellingOneCallerDoesNotCancelAnotherCallersTransfer() {
        var state = SharedWorkState()
        let background = state.join()!, visible = state.join()!
        XCTAssertFalse(state.leave(background))
        XCTAssertTrue(state.leave(visible))
        XCTAssertNil(state.join()); XCTAssertFalse(state.finish())
    }
    func testCompletedTransferCannotBeCancelledOrClaimedAgain() {
        var state = SharedWorkState(); let caller = state.join()!
        XCTAssertTrue(state.finish()); XCTAssertFalse(state.leave(caller)); XCTAssertNil(state.join())
    }
}

final class DocumentMotionStateTests: XCTestCase {
    func testPinchAndScrollAreIndependentAndEndCallbacksDoNotClearContact() {
        var state = DocumentMotionState()
        state.touch(true); state.drag(); state.beginPinch()
        state.dragEnded(decelerating: false)
        XCTAssertTrue(state.pinching); XCTAssertTrue(state.touching)
        state.endPinch(); XCTAssertFalse(state.pinching); XCTAssertTrue(state.touching)
        state.touch(false); XCTAssertFalse(state.touching)
    }
}
