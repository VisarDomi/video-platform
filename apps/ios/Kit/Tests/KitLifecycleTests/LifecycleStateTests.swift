import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
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
    func testReclaimedCancellationDoesNotOccupyAReplacementHandoff() {
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let item = BackgroundTransfers.Item(url: URL(string: "https://fixture.invalid/page")!, file: "pages/one.jpg")
        let old = session.downloadTask(with: item.url)
        old.taskDescription = BackgroundTransfers.encode(item)
        XCTAssertEqual(BackgroundTransfers.liveFiles([old]), Set([item.file]))
        old.cancel()
        XCTAssertTrue(BackgroundTransfers.liveFiles([old]).isEmpty)
        let replacement = session.downloadTask(with: item.url)
        replacement.taskDescription = BackgroundTransfers.encode(item)
        XCTAssertEqual(BackgroundTransfers.liveFiles([old, replacement]), Set([item.file]))
        replacement.cancel()
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
