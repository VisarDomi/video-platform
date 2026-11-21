#if canImport(os)
import os
#else
import Foundation

// Linux (logic tests on the PC): the os.Logger calls Kit and the apps make, printed to stderr.
public enum LogPrivacy: Sendable { case `public`, `private`, auto, sensitive }

public struct LogMessage: ExpressibleByStringInterpolation, Sendable {
    public struct StringInterpolation: StringInterpolationProtocol, Sendable {
        var text = ""
        public init(literalCapacity: Int, interpolationCount: Int) {}
        public mutating func appendLiteral(_ literal: String) { text += literal }
        public mutating func appendInterpolation<T>(_ value: T, privacy: LogPrivacy = .auto) { text += String(describing: value) }
        public mutating func appendInterpolation<T>(_ value: T, format: Any, privacy: LogPrivacy = .auto) { text += String(describing: value) }
    }
    let text: String
    public init(stringLiteral value: String) { text = value }
    public init(stringInterpolation: StringInterpolation) { text = stringInterpolation.text }
}

public struct Logger: Sendable {
    let label: String
    public init(subsystem: String, category: String) { label = subsystem + "." + category }
    private func emit(_ level: String, _ message: LogMessage) {
        FileHandle.standardError.write(Data("[\(label)] \(level): \(message.text)\n".utf8))
    }
    public func debug(_ message: LogMessage) {}
    public func info(_ message: LogMessage) {}
    public func notice(_ message: LogMessage) { emit("notice", message) }
    public func log(_ message: LogMessage) { emit("log", message) }
    public func warning(_ message: LogMessage) { emit("warning", message) }
    public func error(_ message: LogMessage) { emit("error", message) }
    public func fault(_ message: LogMessage) { emit("fault", message) }
}
#endif

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
