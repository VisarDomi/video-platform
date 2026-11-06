import Foundation

@main
struct VideoTerminalStateTests {
    static func main() {
        func check(_ value: Bool, _ label: String) { if !value { fatalError(label) } }
        let duration = 412.271
        check(VideoTerminalState.reachedEnd(duration: duration, time: 412.2, position: 412.2 / duration, inputFailed: false), "sampled final clock is terminal")
        check(VideoTerminalState.reachedEnd(duration: duration, time: 411.25, position: 411.25 / duration, inputFailed: false), "coalesced native stop clock is terminal")
        check(!VideoTerminalState.reachedEnd(duration: duration, time: 120, position: 120 / duration, inputFailed: false), "mid-file disconnect must recover")
        check(!VideoTerminalState.reachedEnd(duration: duration, time: 412.2, position: 412.2 / duration, inputFailed: true), "known input failure is not EOF")
        check(!VideoTerminalState.reachedEnd(duration: duration, time: 412.2, position: 412.2 / duration, inputFailed: false, seeking: true), "queued old EOF cannot terminate a pending seek")
        check(!VideoTerminalState.reachedEnd(duration: duration, time: 412.2, position: 0.5, inputFailed: false), "inconsistent seek clock must not complete")
        check(!VideoTerminalState.reachedEnd(duration: 0, time: 0, position: 0, inputFailed: false), "unopened input is not EOF")
        print("PASS: sampled EOF, network recovery, failed input and seek-clock consistency")
    }
}
