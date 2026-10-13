import Foundation

// Tango's list rules against answers shaped as the gateway sends them.

func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) {
    do { if try !condition() { print("FAIL: " + message); exit(1) } }
    catch { print("FAIL: \(message): \(error)"); exit(1) }
}

func record(_ id: String, ended: Bool = false, status: String = "LIVING", isPublic: Bool = true) -> [String: Any] {
    ["isPublic": isPublic, "anchor": ["encryptedAccountId": id, "firstName": "First \(id)", "aliases": [["alias": "alias\(id)"]]],
     "stream": ["id": "s\(id)", "status": status, "masterListUrl": "https://media.invalid/\(ended ? "ended-" : "")\(id).m3u8"]]
}

func json(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }

@main
struct TangoTests {
    static func main() throws {
        let followed = try Tango.records(json(["records": [record("A"), record("B"), record("X", status: "ENDED"), record("Y", isPublic: false)]]), following: true)
        expect(followed.map(\.streamerId) == ["A", "B"], "Only live public streams")
        expect(followed[0].streamId == "sA" && followed[0].title == "aliasA First A" && followed[0].following, "Stream fields and title")
        let recommended = try Tango.records(json(["records": [record("B"), record("C", ended: true), record("D")]]), following: false)
        let blocked = try Tango.blocklist(json(["users": ["D"]]))
        expect(try Tango.blocklist(json(["D"])) == ["D"], "The blocklist as a plain array")
        let merged = Tango.merge(followed: followed, recommended: recommended, blocked: blocked)
        expect(merged.map(\.streamerId) == ["A", "B", "C"] && merged[1].following, "Followed first, one entry per streamer, never blocked")
        let named = Tango.named(merged, profiles: json(["A": ["basicProfile": ["firstName": "Anna", "aliases": [["alias": "anna1"]]]]]))
        expect(named[0].title == "anna1 Anna" && named[1].title == "aliasB First B", "Names from the profiles where known")
        expect(Tango.named(merged, profiles: Data("oops".utf8)) == merged, "Names are best effort")
        let watch = json(["multiBroadcast": ["streams": ["A", "E", "D"].map { ["stream": ["mbDescriptor": ["accountId": $0, "streamId": "s\($0)"], "streamURL": "https://media.invalid/\($0).m3u8"]] }]])
        let co = try Tango.coStreamers(watch, of: "A", blocked: blocked)
        expect(co.map(\.streamerId) == ["E"] && co[0].parent == "A" && co[0].masterListUrl == "https://media.invalid/E.m3u8", "Co-streamers: not itself, not blocked")
        expect(try Tango.coStreamers(json([:]), of: "A", blocked: []).isEmpty, "No multi-broadcast: none")
        let payload = Data(#"{"accountId":"me","sessionId":"session-1"}"#.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        expect(Tango.claims("h.\(payload).s")! == ("me", "session-1") && Tango.claims("nope") == nil, "The refresh token names the account and session")
        print("PASS: Tango list, names, co-streamers, session claims")
    }
}
