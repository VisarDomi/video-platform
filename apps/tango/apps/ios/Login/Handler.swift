import SafariServices

final class Handler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        // Never log or echo native messages: the import contains credentials.
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        var result: [String: Any] = ["ok": false]
        do {
            guard message?["operation"] as? String == "importTangoLogin",
                  let data = message?["login"], JSONSerialization.isValidJSONObject(data) else {
                throw LoginStore.failure("Invalid import", -1)
            }
            var login = try JSONDecoder().decode(TangoLogin.self, from: JSONSerialization.data(withJSONObject: data))
            let names = Set(["Tango-RT", "Tango-DI", "Tango-DeviceId", "Tango-ST", "Tango-WST"])
            guard login.cookies.count <= 5, login.cookies.allSatisfy({
                names.contains($0.name) && $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")) == "gateway.tango.me"
                && $0.path.hasPrefix("/") && !$0.value.isEmpty && $0.value.count < 32768
                && $0.expirationDate > Date().timeIntervalSince1970
            }) else { throw LoginStore.failure("Invalid Tango cookies", -1) }
            login.handoffComplete = false
            try LoginStore.save(login)
            result = ["ok": true]
        } catch {
            result = ["ok": false, "error": "Login import failed. Check Tango login and try again."]
        }
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: result]
        context.completeRequest(returningItems: [response])
    }
}
