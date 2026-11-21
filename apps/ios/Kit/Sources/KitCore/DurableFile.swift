import Foundation

public enum DurableFileError: Error, Equatable {
    case wrongSize(expected: Int64, actual: Int64?)
    case rename(errno: Int32)
}

// Files that survive a crash or a pulled battery: written whole or not at all, flushed to
// storage before they count. Downloads are committed by renaming a complete file of the
// expected size over the destination, so a reader never sees a partial file.
public enum DurableFile {
    public static func size(_ url: URL) -> Int64? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        guard (attributes?[.type] as? FileAttributeType) == .typeRegular else { return nil }
        return (attributes?[.size] as? NSNumber)?.int64Value
    }

    public static func matches(_ url: URL, size expected: Int64) -> Bool { size(url) == expected }

    public static func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
    }

    // `expectedSize` nil accepts any non-empty file.
    public static func commit(_ source: URL, to destination: URL, expectedSize: Int64?) throws {
        let actual = size(source)
        if let expectedSize { guard actual == expectedSize else { throw DurableFileError.wrongSize(expected: expectedSize, actual: actual) } }
        else { guard (actual ?? 0) > 0 else { throw DurableFileError.wrongSize(expected: 1, actual: actual) } }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        let handle = try FileHandle(forWritingTo: source)
        try handle.synchronize()
        try handle.close()
        // POSIX rename atomically replaces an incomplete destination on the same volume.
        guard rename(source.path, destination.path) == 0 else { throw DurableFileError.rename(errno: errno) }
    }

    public static func readJSON<T: Decodable>(_ type: T.Type, from url: URL, decoder: JSONDecoder = JSONDecoder()) throws -> T? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decoder.decode(type, from: Data(contentsOf: url))
    }

    public static func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try write(encoder.encode(value), to: url)
    }
}
