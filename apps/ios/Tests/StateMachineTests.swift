import Foundation

func require(_ value: @autoclosure () -> Bool, _ message: String) {
    guard value() else { fatalError(message) }
}

@main struct StateMachineTests {
    static func main() {
        var playback = VideoPlaybackState()
        playback.load(play: true); playback.resolved(); playback.ready()
        let seek = playback.seek(resume: true, beforeEnd: true)
        playback.pause()
        require(!playback.mayResumeSeek(seek), "A completed seek must not undo a later pause")
        playback.play()
        let first = playback.seek(resume: true, beforeEnd: true)
        let latest = playback.seek(resume: nil, beforeEnd: true)
        require(!playback.mayResumeSeek(first) && playback.mayResumeSeek(latest), "Only the latest seek may resume")
        playback.end()
        require(!playback.play() && !playback.recover(), "EOF stays terminal across foreground and recovery")
        let replay = playback.seek(resume: true, beforeEnd: true)
        require(playback.mayResumeSeek(replay), "An explicit seek before EOF reopens playback")
        playback.clear()
        require(!playback.mayResumeSeek(replay), "A recycled unit rejects the previous video's seek")
        playback.end(); playback.fail()
        require(playback.phase == .empty, "Late terminal callbacks cannot revive a cleared unit")
        playback.load(play: true); playback.resolved(); playback.recover()
        require(!playback.started, "Failed initial preparation must retain the requested starting position")
        playback.ready(); playback.recover(); playback.recover()
        require(playback.started, "Repeated recovery must retain readiness history and the existing media clock")
        playback.fail(); require(playback.started, "Failure after playback must not fall back to the initial starting position")
        require(!playback.acceptsEnd(seeking: false, current: 100, duration: 100), "Failure is not EOF")
        playback.ready()
        require(!playback.acceptsEnd(seeking: true, current: 100, duration: 100), "A queued EOF cannot terminate an in-flight seek")
        require(!playback.acceptsEnd(seeking: false, current: 20, duration: 100), "An old EOF cannot terminate replay at its new position")
        require(playback.acceptsEnd(seeking: false, current: 100, duration: 100), "The current media's real EOF must remain terminal")
        playback.end(); playback.fail(); playback.ready()
        require(playback.phase == .ended, "Late failure/ready events cannot reopen EOF")
        print("PASS: recovery retains initial/prepared clocks and stale EOF cannot end a seek/replay")

        var user = ViewerPlaybackIntent()
        user.request(.paused)
        require(!user.allows(current: true, policy: true), "Automatic activation must preserve the current video's explicit pause")
        require(user.allows(current: false, policy: true), "Tango live neighbour policy is independent of the current pause")
        require(!user.allows(current: false, policy: false), "VOD neighbour policy must stay paused")
        user.select(); require(user.allows(current: true, policy: true), "Selecting another video starts that video normally")
        print("PASS: explicit user pause survives automatic activation; new selection and live/VOD neighbour policies stay independent")

        var chase = ChasingSeek()
        chase.request(10); let a = chase.begin()!
        for target in 11...100 { chase.request(Double(target)); require(chase.begin() == nil, "Only one backend seek can run") }
        require(chase.complete(a) == .retry, "A newer target must be chased")
        let b = chase.begin()!; require(b.target == 100, "Intermediate targets must be discarded")
        require(chase.complete(a) == .ignored, "An old completion cannot finish a new backend seek")
        chase.rejected(b); require(!chase.isInFlight && chase.target == 100, "Rejected seeks remain waiting for readiness")
        let c = chase.begin()!; chase.cancel(); chase.request(3); let d = chase.begin()!
        require(chase.complete(c) == .ignored && chase.isInFlight, "Cancellation revokes the old completion")
        require(chase.complete(d) == .settled(3) && chase.target == nil, "The current seek settles once")

        var decoder = DecoderLifecycle()
        decoder.play(); decoder.openedInput(); decoder.fail()
        require(!decoder.observedPause() && decoder.failed, "A late pause must not hide an input error or enable EOF classification")
        decoder.end()
        require(decoder.failed && !decoder.terminal, "An input failure is not EOF")
        decoder.openedInput(); decoder.end()
        require(!decoder.play() && !decoder.openedInput(), "Late native ready/playing events cannot reopen EOF")
        decoder.seek(); require(decoder.play(), "Explicit replay is permitted")
        require(decoder.stop() && !decoder.stop(), "Retirement begins once")
        require(!decoder.openedInput() && !decoder.play(), "Retiring decoders cannot play again")
        decoder.retired(); require(decoder.stopping, "Retired decoder remains terminal")
        var output = VideoOutputState.enabled
        output.request(false); output.request(true)
        require(output.needsRestore, "Returning output waits for foreground")
        output.request(false); output.restored()
        require(!output.requested, "A late restore cannot undo a new suspension")

        var interaction = ViewerInteractionState()
        interaction.contact(true); require(!interaction.revealsNeighbors, "A resting finger does not reveal neighbours")
        interaction.drag(); require(interaction.revealsNeighbors, "Free scrolling reveals neighbours")
        interaction.dragEnded(decelerating: true); require(interaction.revealsNeighbors, "Momentum remains free scrolling")
        interaction.pinch(); require(!interaction.revealsNeighbors && interaction.zoomed, "Pinch immediately disables the carousel")
        interaction.magnify(); interaction.drag(); require(!interaction.scrolling, "Zoom pans never start carousel scrolling")
        interaction.unzoom(); interaction.settle(); require(!interaction.revealsNeighbors, "At rest only the current video is visible")
        var retouch = ViewerInteractionState()
        retouch.contact(true); retouch.drag(); retouch.contact(false); retouch.dragEnded(decelerating: true)
        require(retouch.revealsNeighbors, "Momentum reveals neighbours before retouch")
        retouch.contact(true)
        require(retouch.revealsNeighbors, "Retouching momentum must not hide neighbours before dragging resumes")
        retouch.drag(); retouch.dragEnded(decelerating: false)
        require(retouch.revealsNeighbors && retouch.touching, "Drag-end cannot settle while the contact is still down")
        retouch.contact(false); retouch.settle()
        require(!retouch.revealsNeighbors, "A genuinely settled scroll returns to current-only visibility")
        gestureEquivalence()
        var presentation = ViewerPresentationState(); presentation.open(); presentation.close()
        require(!presentation.reveal(), "A late reveal timer cannot reopen a closed viewer")
        print("PASS: playback intent, EOF/replay, seek ownership/chasing, retirement, output restore and carousel state transitions")
    }
}

// Reference event semantics taken from pre-refactor ViewerController (9d0ecf4).
// Touch, unsettled scrolling and zoom were independent facts. Compare every
// intermediate state, including the two legal UIKit callback orders.
private enum GestureEvent { case down, up, drag, endDrag(Bool), endDecel, pinch, zoomEnd(Bool), flush }
private func gestureEquivalence() {
    typealias E = GestureEvent
    let traces: [[E]] = [
        [.down, .drag, .up, .endDrag(false), .flush],
        [.down, .drag, .endDrag(false), .up, .flush],
        [.down, .drag, .up, .endDrag(true), .down, .drag, .up, .endDrag(true), .endDecel, .flush],
        [.down, .drag, .up, .endDrag(true), .down, .endDecel, .flush, .up, .flush],
        [.down, .drag, .up, .endDrag(true), .down, .up, .flush, .endDecel],
        [.down, .drag, .up, .endDrag(true), .endDecel, .down, .up, .flush],
        [.down, .drag, .pinch, .up, .endDrag(false), .zoomEnd(false), .flush],
        [.down, .pinch, .zoomEnd(true), .up, .flush, .down, .zoomEnd(false), .up, .flush],
        [.down, .up, .flush],
    ]
    for (number, trace) in traces.enumerated() {
        var model = ViewerInteractionState()
        var oldTouch = false, oldUnsettled = false, oldZoom = false
        var dragging = false, decelerating = false
        func check(_ step: Int) {
            require(model.touching == oldTouch, "Touch must remain independent: trace \(number), step \(step)")
            require(model.scrolling == oldUnsettled, "Scroll lifetime changed: trace \(number), step \(step)")
            require(model.zoomed == oldZoom, "Zoom lifetime changed: trace \(number), step \(step)")
            require(model.revealsNeighbors == (oldUnsettled && !oldZoom), "Neighbour flicker: trace \(number), step \(step)")
        }
        func settle() {
            if !oldZoom && !oldTouch && !dragging && !decelerating { oldUnsettled = false }
            if !model.zoomed && !model.touching && !dragging && !decelerating { model.settle() }
        }
        for (step, event) in trace.enumerated() {
            switch event {
            case .down: oldTouch = true; model.contact(true)
            case .up: oldTouch = false; model.contact(false)
            case .drag:
                dragging = true; decelerating = false
                oldUnsettled = true; model.drag()
            case .endDrag(let coast):
                dragging = false; decelerating = coast
                model.dragEnded(decelerating: coast)
                if !coast { settle() }
            case .endDecel: decelerating = false; settle()
            case .pinch:
                oldZoom = true; oldUnsettled = false
                dragging = false; decelerating = false; model.pinch()
            case .zoomEnd(let magnified):
                oldZoom = magnified
                if magnified { model.magnify() } else { model.unzoom(); settle() }
            case .flush: settle()
            }
            check(step)
        }
    }
    print("PASS: pre-refactor gesture equivalence, retouch during momentum, contact cancellation and both drag-end callback orders")
}
