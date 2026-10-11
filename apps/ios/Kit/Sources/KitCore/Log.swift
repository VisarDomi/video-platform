import os

// Unified logging categories, readable from the Mac with
// `log stream --device ... --predicate 'subsystem == "nativekit"'`.
public enum Log {
    public static let store = Logger(subsystem: "nativekit", category: "store")
    public static let network = Logger(subsystem: "nativekit", category: "network")
    public static let images = Logger(subsystem: "nativekit", category: "images")
    public static let navigation = Logger(subsystem: "nativekit", category: "navigation")
    public static let lifecycle = Logger(subsystem: "nativekit", category: "lifecycle")
    public static let app = Logger(subsystem: "nativekit", category: "app")
}
