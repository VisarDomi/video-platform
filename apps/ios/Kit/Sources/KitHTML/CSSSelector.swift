import Foundation

// CSS selectors translated to XPath, for the subset scrapers use: `tag`, `*`, `#id`, `.class`,
// `[attr]`, `[attr=v]`, `[attr^=v]`, `[attr$=v]`, `[attr*=v]`, `[attr~=v]`, `:first-child`,
// `:last-child`, `:nth-child(n)`, `:not(simple)`, combinators ` `, `>`, `+`, `~`, and `,`
// groups. libxml2 lowercases HTML tag and attribute names, so names are matched lowercased.
enum CSSSelector {
    static func xpath(_ selector: String, relative: Bool) throws -> String {
        let groups = try split(selector)
        guard !groups.isEmpty else { throw HTMLError.selector(selector) }
        return try groups.map { try translate($0, relative: relative, original: selector) }.joined(separator: " | ")
    }

    // Splits on top-level commas (not inside brackets, parentheses or quotes).
    private static func split(_ selector: String) throws -> [String] {
        var groups: [String] = [], current = "", depth = 0
        var quote: Character?
        for character in selector {
            if let open = quote { current.append(character); if character == open { quote = nil }; continue }
            switch character {
            case "\"", "'": quote = character; current.append(character)
            case "[", "(": depth += 1; current.append(character)
            case "]", ")": depth -= 1; current.append(character)
            case "," where depth == 0: groups.append(current); current = ""
            default: current.append(character)
            }
        }
        groups.append(current)
        return groups.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private enum Token { case compound(String), combinator(Character) }

    private static func translate(_ selector: String, relative: Bool, original: String) throws -> String {
        let tokens = try tokenize(selector, original: original)
        var path = relative ? "." : ""
        var pending: Character = " "
        for token in tokens {
            switch token {
            case .combinator(let combinator): pending = combinator
            case .compound(let compound):
                let (tag, predicates) = try parseCompound(compound, original: original)
                let step = tag + predicates.map { "[\($0)]" }.joined()
                switch pending {
                case ">": path += "/" + step
                case "+": path += "/following-sibling::*[1]/self::" + step
                case "~": path += "/following-sibling::" + step
                default: path += "//" + step
                }
                pending = " "
            }
        }
        return path
    }

    private static func tokenize(_ selector: String, original: String) throws -> [Token] {
        var tokens: [Token] = [], current = "", depth = 0
        var quote: Character?
        func flush() { if !current.isEmpty { tokens.append(.compound(current)); current = "" } }
        for character in selector {
            if let open = quote { current.append(character); if character == open { quote = nil }; continue }
            if depth > 0 {
                if character == "\"" || character == "'" { quote = character }
                else if character == "[" || character == "(" { depth += 1 }
                else if character == "]" || character == ")" { depth -= 1 }
                current.append(character)
                continue
            }
            switch character {
            case "\"", "'": quote = character; current.append(character)
            case "[", "(": depth += 1; current.append(character)
            case "]", ")": throw HTMLError.selector(original)
            case ">", "+", "~":
                flush()
                if case .combinator = tokens.last { tokens.removeLast() }
                tokens.append(.combinator(character))
            case " ", "\t", "\n":
                flush()
                if let last = tokens.last, case .compound = last { tokens.append(.combinator(" ")) }
            default: current.append(character)
            }
        }
        flush()
        if case .combinator = tokens.last { tokens.removeLast() }
        guard depth == 0, quote == nil, tokens.contains(where: { if case .compound = $0 { return true }; return false }) else {
            throw HTMLError.selector(original)
        }
        return tokens
    }

    private static func parseCompound(_ compound: String, original: String) throws -> (String, [String]) {
        let characters = Array(compound)
        var index = 0
        var tag = "*"
        var predicates: [String] = []
        func readName() -> String {
            var name = ""
            while index < characters.count, characters[index].isLetter || characters[index].isNumber || "-_".contains(characters[index]) {
                name.append(characters[index]); index += 1
            }
            return name
        }
        if index < characters.count, characters[index] == "*" { index += 1 }
        else if index < characters.count, characters[index].isLetter { tag = readName().lowercased() }
        while index < characters.count {
            let character = characters[index]
            index += 1
            switch character {
            case "#":
                predicates.append("@id=\(literal(readName()))")
            case ".":
                predicates.append("contains(concat(' ', normalize-space(@class), ' '), \(literal(" " + readName() + " ")))")
            case "[":
                guard let close = characters[index...].firstIndex(of: "]") else { throw HTMLError.selector(original) }
                predicates.append(try attribute(String(characters[index..<close]), original: original))
                index = close + 1
            case ":":
                let name = readName().lowercased()
                var argument = ""
                if index < characters.count, characters[index] == "(" {
                    guard let close = characters[index...].lastIndex(of: ")") else { throw HTMLError.selector(original) }
                    argument = String(characters[(index + 1)..<close])
                    index = close + 1
                }
                switch name {
                case "first-child": predicates.append("not(preceding-sibling::*)")
                case "last-child": predicates.append("not(following-sibling::*)")
                case "nth-child":
                    guard let n = Int(argument.trimmingCharacters(in: .whitespaces)), n > 0 else { throw HTMLError.selector(original) }
                    predicates.append("count(preceding-sibling::*) = \(n - 1)")
                case "not":
                    let (innerTag, inner) = try parseCompound(argument.trimmingCharacters(in: .whitespaces), original: original)
                    var conditions = inner
                    if innerTag != "*" { conditions.append("self::\(innerTag)") }
                    guard !conditions.isEmpty else { throw HTMLError.selector(original) }
                    predicates.append("not(" + conditions.joined(separator: " and ") + ")")
                default: throw HTMLError.selector(original)
                }
            default:
                throw HTMLError.selector(original)
            }
        }
        return (tag, predicates)
    }

    private static func attribute(_ body: String, original: String) throws -> String {
        let operators = ["^=", "$=", "*=", "~=", "="]
        for op in operators {
            if let range = body.range(of: op) {
                let name = body[..<range.lowerBound].trimmingCharacters(in: .whitespaces).lowercased()
                var value = body[range.upperBound...].trimmingCharacters(in: .whitespaces)
                if value.count >= 2, let first = value.first, first == value.last, first == "\"" || first == "'" { value = String(value.dropFirst().dropLast()) }
                guard !name.isEmpty else { throw HTMLError.selector(original) }
                let attribute = "@" + name, quoted = literal(value)
                switch op {
                case "^=": return "starts-with(\(attribute), \(quoted))"
                case "$=": return "substring(\(attribute), string-length(\(attribute)) - string-length(\(quoted)) + 1) = \(quoted)"
                case "*=": return "contains(\(attribute), \(quoted))"
                case "~=": return "contains(concat(' ', normalize-space(\(attribute)), ' '), \(literal(" " + value + " ")))"
                default: return "\(attribute)=\(quoted)"
                }
            }
        }
        let name = body.trimmingCharacters(in: .whitespaces).lowercased()
        guard !name.isEmpty else { throw HTMLError.selector(original) }
        return "@" + name
    }

    // An XPath string literal for any text (XPath 1.0 has no escapes).
    static func literal(_ text: String) -> String {
        if !text.contains("'") { return "'\(text)'" }
        if !text.contains("\"") { return "\"\(text)\"" }
        return "concat(" + text.split(separator: "'", omittingEmptySubsequences: false).map { "'\($0)'" }.joined(separator: ", \"'\", ") + ")"
    }
}
