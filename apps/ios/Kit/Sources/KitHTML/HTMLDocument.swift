import Foundation
import libxml2

public enum HTMLError: Error, Equatable {
    case unparsable
    case selector(String)
}

// A parsed HTML page (the system libxml2, tolerant of tag soup), queried with CSS selectors
// (the subset in CSSSelector.swift) or XPath. Replaces the web code's DOMParser. Not
// Sendable: parse and query in one place, keep only the strings you extract.
public final class HTMLDocument {
    let pointer: htmlDocPtr

    private static let initialized: Bool = { xmlInitParser(); return true }()

    public init(data: Data, encoding: String? = "UTF-8") throws {
        _ = Self.initialized
        let options = Int32(HTML_PARSE_RECOVER.rawValue | HTML_PARSE_NOERROR.rawValue | HTML_PARSE_NOWARNING.rawValue
                            | HTML_PARSE_NONET.rawValue | HTML_PARSE_NOBLANKS.rawValue | HTML_PARSE_COMPACT.rawValue)
        let parsed: htmlDocPtr? = data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress?.assumingMemoryBound(to: CChar.self), !bytes.isEmpty else { return nil }
            return htmlReadMemory(base, Int32(bytes.count), nil, encoding, options)
        }
        guard let parsed else { throw HTMLError.unparsable }
        pointer = parsed
    }

    public convenience init(_ string: String) throws { try self.init(data: Data(string.utf8)) }

    deinit { xmlFreeDoc(pointer) }

    public var root: HTMLNode? { xmlDocGetRootElement(pointer).map { HTMLNode(document: self, pointer: $0) } }

    public func select(_ selector: String) throws -> [HTMLNode] { try xpath(CSSSelector.xpath(selector, relative: false)) }
    public func first(_ selector: String) throws -> HTMLNode? { try select(selector).first }

    public func xpath(_ expression: String, context: xmlNodePtr? = nil) throws -> [HTMLNode] {
        guard let xpathContext = xmlXPathNewContext(pointer) else { return [] }
        defer { xmlXPathFreeContext(xpathContext) }
        if let context { xpathContext.pointee.node = context }
        guard let result = xmlXPathEvalExpression(expression, xpathContext) else { throw HTMLError.selector(expression) }
        defer { xmlXPathFreeObject(result) }
        guard let set = result.pointee.nodesetval, set.pointee.nodeNr > 0, let table = set.pointee.nodeTab else { return [] }
        return (0..<Int(set.pointee.nodeNr)).compactMap { table[$0].map { HTMLNode(document: self, pointer: $0) } }
    }

    public var title: String? { try? first("title")?.text.trimmingCharacters(in: .whitespacesAndNewlines) }
}

public struct HTMLNode {
    // Keeps the document (and so the node's memory) alive.
    public let document: HTMLDocument
    let pointer: xmlNodePtr

    public var name: String { pointer.pointee.name.map { String(cString: $0) } ?? "" }
    public var isElement: Bool { pointer.pointee.type == XML_ELEMENT_NODE }

    public subscript(attribute: String) -> String? {
        guard let value = xmlGetProp(pointer, attribute) else { return nil }
        defer { release(value) }
        return String(cString: value)
    }

    public var attributes: [String: String] {
        var result: [String: String] = [:]
        var attribute = pointer.pointee.properties
        while let current = attribute {
            if let name = current.pointee.name.map({ String(cString: $0) }) { result[name] = self[name] }
            attribute = current.pointee.next
        }
        return result
    }

    // All descendant text, as textContent.
    public var text: String {
        guard let content = xmlNodeGetContent(pointer) else { return "" }
        defer { release(content) }
        return String(cString: content)
    }

    // Text with runs of whitespace collapsed and the ends trimmed.
    public var normalizedText: String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    public var parent: HTMLNode? {
        guard let parent = pointer.pointee.parent, parent.pointee.type == XML_ELEMENT_NODE else { return nil }
        return HTMLNode(document: document, pointer: parent)
    }

    public var children: [HTMLNode] {
        var result: [HTMLNode] = []
        var child = pointer.pointee.children
        while let current = child {
            if current.pointee.type == XML_ELEMENT_NODE { result.append(HTMLNode(document: document, pointer: current)) }
            child = current.pointee.next
        }
        return result
    }

    public var outerHTML: String {
        guard let buffer = xmlBufferCreate() else { return "" }
        defer { xmlBufferFree(buffer) }
        htmlNodeDump(buffer, document.pointer, pointer)
        return xmlBufferContent(buffer).map { String(cString: $0) } ?? ""
    }

    // Descendants matching a CSS selector (`>` at the start means direct children).
    public func select(_ selector: String) throws -> [HTMLNode] {
        try document.xpath(CSSSelector.xpath(selector, relative: true), context: pointer)
    }

    public func first(_ selector: String) throws -> HTMLNode? { try select(selector).first }

    public func xpath(_ expression: String) throws -> [HTMLNode] { try document.xpath(expression, context: pointer) }
}

// libxml2's strings come from the system allocator (Apple's libxml2 keeps the default
// xmlFree, which is free); its global xmlFree pointer is not visible to Swift 6 code.
private func release(_ pointer: UnsafeMutablePointer<xmlChar>) { free(pointer) }
