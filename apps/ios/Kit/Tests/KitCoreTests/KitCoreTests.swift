import Foundation
import Testing
@testable import KitCore

private func temporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("kit-core-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@Test func durableWriteAndJSON() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("nested/state.json")
    try DurableFile.writeJSON(["b": 2, "a": 1], to: file)
    #expect(String(decoding: try Data(contentsOf: file), as: UTF8.self) == #"{"a":1,"b":2}"#)
    #expect(try DurableFile.readJSON([String: Int].self, from: file) == ["a": 1, "b": 2])
    #expect(try DurableFile.readJSON([String: Int].self, from: directory.appendingPathComponent("missing.json")) == nil)
}

@Test func commitChecksSizeAndReplaces() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let destination = directory.appendingPathComponent("media/page.jpg")
    let partial = directory.appendingPathComponent("partial")
    try Data(repeating: 1, count: 3).write(to: partial)
    #expect(throws: DurableFileError.wrongSize(expected: 5, actual: 3)) { try DurableFile.commit(partial, to: destination, expectedSize: 5) }
    #expect(!FileManager.default.fileExists(atPath: destination.path))
    let complete = directory.appendingPathComponent("complete")
    try Data(repeating: 2, count: 5).write(to: complete)
    try DurableFile.commit(complete, to: destination, expectedSize: 5)
    #expect(DurableFile.matches(destination, size: 5))
    #expect(!FileManager.default.fileExists(atPath: complete.path))
    let empty = directory.appendingPathComponent("empty")
    try Data().write(to: empty)
    #expect(throws: DurableFileError.self) { try DurableFile.commit(empty, to: destination, expectedSize: nil) }
}

@Test func backgroundWriterKeepsNewestAndClears() throws {
    let directory = try temporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let writer = BackgroundWriter(url: directory.appendingPathComponent("checkpoint.json"))
    for value in 0..<50 { writer.save(json: ["value": value]) }
    writer.flush()
    #expect(try DurableFile.readJSON([String: Int].self, from: writer.url) == ["value": 49])
    writer.save(json: ["value": 50])
    writer.clear()
    writer.flush()
    #expect(!FileManager.default.fileExists(atPath: writer.url.path))
}
