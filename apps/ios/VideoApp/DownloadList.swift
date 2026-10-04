import Foundation
import WebKit

// Video Vault: the viewer's +/- button edits the PC download list of an upload's recording.
// Like the live extensions' background page, the app makes the PC requests, so the site's own
// security policy (XVideos allows no other origins) never applies. Only the site's main frame
// may ask, only for the three lists, and only member/exists/add/remove.
@MainActor
final class DownloadList: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "downloadList"
    private let server = URL(string: "https://192.168.1.197:9999")!
    private let lists: Set<String> = ["tango", "fc2", "sc"]
    private let hosts: [String]

    init(hosts: [String]) { self.hosts = hosts }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) async -> (Any?, String?) {
        guard message.frameInfo.isMainFrame, hosts.contains(message.frameInfo.securityOrigin.host),
              let body = message.body as? [String: Any], let list = body["list"] as? String, lists.contains(list),
              let action = body["action"] as? String, ["member", "exists", "add", "remove"].contains(action),
              let identifier = body["identifier"] as? String, !identifier.isEmpty else {
            return (nil, "Unsupported download-list request.")
        }
        var url = URLComponents(url: server.appendingPathComponent("api/\(list)/\(action)"), resolvingAgainstBaseURL: false)!
        let lookup = action == "member" || action == "exists"
        if lookup {
            url.percentEncodedQuery = "identifier=" + identifier.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        }
        var request = URLRequest(url: url.url!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        if !lookup {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["identifier": identifier])
        }
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            return (["status": (response as? HTTPURLResponse)?.statusCode ?? 0, "body": String(decoding: data, as: UTF8.self)], nil)
        } catch {
            return (nil, error.localizedDescription)
        }
    }
}
