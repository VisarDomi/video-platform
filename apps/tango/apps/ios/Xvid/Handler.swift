import SafariServices

// Xvid uses Safari cookies and has no native messaging API.
final class Handler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil)
    }
}
