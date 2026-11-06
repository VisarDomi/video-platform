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
        var presentation = ViewerPresentationState(); presentation.open(); presentation.close()
        require(!presentation.reveal(), "A late reveal timer cannot reopen a closed viewer")
        print("PASS: playback intent, EOF/replay, seek ownership/chasing, retirement, output restore and carousel state transitions")
    }
}
