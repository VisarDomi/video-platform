import Foundation

// What an app's providers are, from its Info.plist (scripts/project.py writes them from
// apps.json), so the shell never names a site:
// - LiveProviders: live streams; neighbouring videos keep playing, frames are 9:16.
// - OriginalFileProviders: a library of original files (a file host's); one decoder at a
//   time, a two-second buffer, renaming on the PC.
// - ListNames: each download list's display name, for the +/- button.
enum ProviderTraits {
    static let live = Set(Bundle.main.object(forInfoDictionaryKey: "LiveProviders") as? [String] ?? [])
    static let originalFiles = Set(Bundle.main.object(forInfoDictionaryKey: "OriginalFileProviders") as? [String] ?? [])
    static let listNames = Bundle.main.object(forInfoDictionaryKey: "ListNames") as? [String: String] ?? [:]
}
