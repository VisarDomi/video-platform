// A navigation snapshot can depend on model files as well as its route/state file.
// The navigation owner captures the screen first, then drains this store. Async
// actor writes are joined under its lifecycle save lease before suspension.
@MainActor
public protocol CheckpointStore: AnyObject {
    func flush()
    func finishWrites() async
}

public extension CheckpointStore {
    func finishWrites() async {}
}
