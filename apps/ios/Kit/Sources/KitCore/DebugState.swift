import Foundation

// What the inspector used to read from a WebKit page: each part of the app reports a small
// JSON-able snapshot (current screen, scroll anchors, loaded images, queue lengths) and the
// app writes them all to `debug-state.json` in its data folder whenever it resigns active.
// From the Mac: `xcrun devicectl device copy from --domain-type appDataContainer
// --domain-identifier <bundle> --source "Library/Application Support/<App>/debug-state.json"`.
@MainActor
public final class DebugState {
    public static let shared = DebugState()
    private var reporters: [(String, () -> Any)] = []

    public func register(_ name: String, _ report: @escaping () -> Any) {
        reporters.removeAll { $0.0 == name }
        reporters.append((name, report))
    }

    public func snapshot() -> [String: Any] {
        var value: [String: Any] = ["time": ISO8601DateFormatter().string(from: Date())]
        for (name, report) in reporters { value[name] = report() }
        return value
    }

    public func write(to directory: URL) {
        let value = snapshot()
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]) else {
            Log.app.error("Debug state is not JSON")
            return
        }
        try? DurableFile.write(data, to: directory.appendingPathComponent("debug-state.json"))
    }
}
