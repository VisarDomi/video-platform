import SafariServices

// Tango's FC2 live and SC live extensions talk only to the PC; there is no native messaging.
final class Handler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: nil)
    }
}
