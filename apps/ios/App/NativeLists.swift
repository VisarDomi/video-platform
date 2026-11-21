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
        case "live":
            // A live site with an account (LiveList.swift): the site's ID is the app's live
            // provider, its address Info.plist LiveSite.
            guard let site = (Bundle.main.object(forInfoDictionaryKey: "LiveProviders") as? [String])?.first,
                  let base = (Bundle.main.object(forInfoDictionaryKey: "LiveSite") as? String).flatMap(URL.init(string:)) else { return nil }
            let list = LiveListController(site: site, base: base)
            return Opened(list: list, resumed: { [weak list] in list?.resumed(afterBackground: $0) }, paused: { [weak list] in list?.paused() })
        default: return nil
        }
    }
}
