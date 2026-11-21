import Foundation

// The site lists an app can open instead of the PC's recordings (Info.plist NativeList), each a
// VideoListController of its own with what it does when the app becomes active or goes to the
// background.
@MainActor
enum NativeLists {
    struct Opened {
        let list: VideoListController
        let resumed: (Bool) -> Void
        let paused: () -> Void
    }

    static func make(_ name: String) -> Opened? {
        switch name {
        default: return nil
        }
    }
}
