// Offline protocol fixture. Never accesses the device Keychain or real Tango.
import Foundation

final class Fixture {
    static var saved = TangoLogin(cookies:[cookie("Tango-RT", token("first"))],handoffComplete:true)
    static var order: [String] = []
    static var jar: HTTPCookieStorage!
    static var failPlayback = true
    static var now = Date()
    static func token(_ id: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject:["accountId":"fixture-account","sessionId":id])
        return "header." + data.base64EncodedString().replacingOccurrences(of:"=",with:"") + ".signature"
    }
    static func cookie(_ name: String, _ value: String) -> LoginCookie {
        LoginCookie(name:name,value:value,domain:"gateway.tango.me",path:name == "Tango-RT" ? "/session-service/public/v2/session/web/refresh" : "/",expirationDate:Date().addingTimeInterval(86400).timeIntervalSince1970)
    }
}
final class ProtocolFixture: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url!.path.contains("/follow/") {
            assert(request.value(forHTTPHeaderField:"Content-Type") == "text/plain;charset=UTF-8",
                   "Follow's string body must retain the browser XHR content type")
            assert(request.value(forHTTPHeaderField:"Accept") == "application/json; charset=UTF-8")
            complete(status:200,data:Data("{}".utf8)); return
        }
        if request.url!.path.hasSuffix("/profiles/v2/batch") {
            assert(request.value(forHTTPHeaderField:"Content-Type") == "application/json",
                   "Explicit JSON content type must remain unchanged")
            complete(status:200,data:Data("{}".utf8)); return
        }
        if request.url!.path == "/abregistrar/connection/v1/blocklist" {
            assert(request.httpMethod == "POST")
            assert(request.value(forHTTPHeaderField:"Content-Type") == "application/json",
                   "Block must retain its explicit JSON content type")
            complete(status:200,data:Data("{\"error_code\":0}".utf8)); return
        }
        if request.url!.path == "/master.m3u8" || request.url!.path == "/variant.m3u8" {
            assert(request.value(forHTTPHeaderField:"Cookie")?.contains("tt=fixture") == true)
            let body = request.url!.path == "/master.m3u8"
                ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvariant.m3u8\n"
                : "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://cdn.fixture.invalid/key\"\n#EXT-X-MAP:URI=\"https://cdn.fixture.invalid/init\"\n#EXTINF:4,\nhttps://cdn.fixture.invalid/segment\n"
            complete(status:200,data:Data(body.utf8)); return
        }
        if request.url!.host == "cdn.fixture.invalid" {
            assert(request.value(forHTTPHeaderField:"Cookie") == nil,"Never leak Tango playback cookies to an unrelated CDN")
            complete(status:request.value(forHTTPHeaderField:"Range") == nil ? 200 : 206,data:Data([1,2,3,4]));return
        }
        let refresh = request.url!.path.hasSuffix("/refresh")
        Fixture.order.append(refresh ? "refresh" : "playback")
        let status: Int
        if refresh {
            // Emulate the cookie store mutation performed by URLSession when a
            // successful refresh response replaces Tango-RT and Tango-ST.
            let rt = Fixture.cookie("Tango-RT",Fixture.token("rotated"))
            Fixture.jar.setCookie(HTTPCookie(properties:[.name:rt.name,.value:rt.value,.domain:rt.domain,.path:rt.path,.expires:Date(timeIntervalSince1970:rt.expirationDate),.secure:"TRUE"])!)
            status = 200
        } else {
            assert(Fixture.saved.session?["sessionId"] == "rotated", "Rotation must be durably saved BEFORE playback starts")
            status = Fixture.failPlayback ? 503 : 200
            if status == 200 {
                for name in ["tt","ttu","tte"] {
                    Fixture.jar.setCookie(HTTPCookie(properties:[.name:name,.value:"fixture",.domain:".tango.me",.path:"/",.expires:Date().addingTimeInterval(10),.secure:"TRUE"])!)
                }
            }
        }
        complete(status:status,data:Data("{}".utf8))
    }
    func complete(status: Int, data: Data) {
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:nil,headerFields:[:])!,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:data);client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
@main struct AuthTests {
    static func main() async throws {
        let auth = TangoAuth(readLogin:{ Fixture.saved },saveLogin:{ login in Fixture.order.append("save");Fixture.saved=login },configuration:{
            let config=URLSessionConfiguration.ephemeral;config.protocolClasses=[ProtocolFixture.self];Fixture.jar=config.httpCookieStorage!;return config
        },now:{ Fixture.now })
        await withTaskGroup(of:Void.self) { group in
            for _ in 0..<20 { group.addTask { _ = try? await auth.authenticate() } }
        }
        let firstCount = await auth.refreshCount
        assert(firstCount == 1,"Simultaneous callers must consume RT only once")
        assert(Fixture.saved.session?["sessionId"] == "rotated","Playback failure must retain replacement RT")
        assert(Array(Fixture.order.prefix(3)) == ["refresh","save","playback"])
        Fixture.failPlayback=false
        _ = try await auth.authenticate()
        let secondCount = await auth.refreshCount
        assert(secondCount == 1,"Playback retry must not rotate a valid session")
        let before=Fixture.order.count
        _ = try await auth.authenticate()
        assert(Fixture.order.count == before,"Page navigation reuses fresh playback credentials")
        await auth.finishPendingRefresh()
        assert(Fixture.order.count == before,"Background draining starts no request")
        let relay = MediaRelay(auth:auth,now:{ Fixture.now })
        let root = try await relay.resolve("https://cinema.tango.me/master.m3u8")
        let (master,_) = try await URLSession.shared.data(from:URL(string:root)!)
        let variant = String(decoding:master,as:UTF8.self).split(separator:"\n").last!
        assert(variant.hasPrefix("http://127.0.0.1:"))
        let (playlist,_) = try await URLSession.shared.data(from:URL(string:String(variant))!)
        let text = String(decoding:playlist,as:UTF8.self)
        assert(!text.contains("cdn.fixture.invalid"),"Every HLS URI goes through the local relay")
        let regex = try NSRegularExpression(pattern:"URI=\"([^\"]+)\"")
        for match in regex.matches(in:text,range:NSRange(text.startIndex...,in:text)) {
            let path=String(text[Range(match.range(at:1),in:text)!])
            let (data,_) = try await URLSession.shared.data(from:URL(string:path)!)
            assert(data == Data([1,2,3,4]),"Keys and init data pass through unchanged")
        }
        let segment=String(text.split(separator:"\n").last!)
        var request=URLRequest(url:URL(string:segment)!);request.setValue("bytes=0-3",forHTTPHeaderField:"Range")
        let (data,response)=try await URLSession.shared.data(for:request)
        assert((response as? HTTPURLResponse)?.statusCode == 206 && data == Data([1,2,3,4]))
        // WebKit can retain a master, variant, encryption key or init URI while
        // the app is backgrounded. Advancing a fixture clock avoids real waits.
        Fixture.now = Fixture.now.addingTimeInterval(121)
        _ = try await URLSession.shared.data(from:URL(string:root)!)
        let (_,expiredSegment)=try await URLSession.shared.data(from:URL(string:segment)!)
        assert((expiredSegment as? HTTPURLResponse)?.statusCode == 404,"Obsolete live segments still expire")
        for match in regex.matches(in:text,range:NSRange(text.startIndex...,in:text)) {
            let path=String(text[Range(match.range(at:1),in:text)!])
            let (bytes,reply) = try await URLSession.shared.data(from:URL(string:path)!)
            assert((reply as? HTTPURLResponse)?.statusCode == 200 && bytes == Data([1,2,3,4]),
                   "A cached HLS key/init URI must survive segment expiry")
        }
        let (_,cachedVariant) = try await URLSession.shared.data(from:URL(string:String(variant))!)
        assert((cachedVariant as? HTTPURLResponse)?.statusCode == 200,"Cached variant must survive expiry")
        let keyMatch=regex.firstMatch(in:text,range:NSRange(text.startIndex...,in:text))!
        let keyURL=String(text[Range(keyMatch.range(at:1),in:text)!])
        var head=URLRequest(url:URL(string:keyURL)!);head.httpMethod="HEAD"
        let (empty,headReply)=try await URLSession.shared.data(for:head)
        assert(empty.isEmpty && (headReply as? HTTPURLResponse)?.value(forHTTPHeaderField:"Content-Length") == "4",
               "HEAD returns GET's representation length without its body")
        Fixture.now = Fixture.now.addingTimeInterval(30*60+1)
        _ = try await auth.authenticate()
        let timedRefresh = await auth.refreshCount
        assert(timedRefresh == 2,"The native owner renews the session at 30 minutes")
        for action in ["add","remove"] {
            _ = try await auth.request(JSONSerialization.data(withJSONObject:[
                "url":"https://gateway.tango.me/proxycador/api/public/v1/follow/"+action,
                "method":"POST","headers":["Accept":"application/json; charset=UTF-8"],"body":"fixture-id"
            ]))
        }
        _ = try await auth.request(JSONSerialization.data(withJSONObject:[
            "url":"https://gateway.tango.me/proxycador/api/public/v1/profiles/v2/batch",
            "method":"POST","headers":["content-type":"application/json"],"body":"[]"
        ]))
        _ = try await auth.request(JSONSerialization.data(withJSONObject:[
            "url":"https://gateway.tango.me/abregistrar/connection/v1/blocklist",
            "method":"POST","headers":["Content-Type":"application/json"],
            "body":"{\"action\":\"BLOCK\",\"account_id\":[\"fixture-id\"]}"
        ]))
        print("PASS: Follow/unfollow string content type and Block/explicit JSON request parity")
        print("PASS: cached playlist/key/init survive background expiry; segments retire; HEAD length matches GET")
        print("PASS: loopback HLS master/variant/key/init/segment transport, byte ranges and cookie scoping")
        print("PASS: single-flight refresh, immediate replacement persistence, failed playback recovery, navigation reuse and background drain")
    }
}
