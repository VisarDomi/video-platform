import UIKit

// A site's own list, which an app opens instead of the PC's recordings (Info.plist NativeList):
// a provider plug-in's VideoListController. Each plug-in names its lists (and any simulator
// checks) in its plugin.json; scripts/project.py writes Plugins.generated.swift from them, so
// the engine never names a plug-in.
@MainActor
protocol SiteList: VideoListController {
    // The list from the app's Info.plist; nil when it lacks what the list needs.
    static func make() -> Self?
    func resumed(afterBackground: Bool)
    func paused()
}

@MainActor
enum NativeLists {
    struct Opened {
        let list: VideoListController
        let resumed: (Bool) -> Void
        let paused: () -> Void
    }

    static func open<List: SiteList>(_ type: List.Type) -> Opened? {
        guard let list = type.make() else { return nil }
        return Opened(list: list, resumed: { [weak list] in list?.resumed(afterBackground: $0) }, paused: { [weak list] in list?.paused() })
    }

    static func make(_ name: String) -> Opened? { Plugins.list(name) }
}
