import SafariServices

// A hosted Safari web extension's native side: the extensions an app carries talk only to the
// PC, so there is no native messaging.
final class Handler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil)
    }
}
