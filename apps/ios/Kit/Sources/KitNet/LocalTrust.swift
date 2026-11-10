import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Security)
import Security
#endif

// The PC's servers use a local CA (mkcert) bundled with each app. Only the PC's host may use
// it, as the only anchor; hostname and validity are still checked, and every other host gets
// the system's default handling. Never an accept-all handler.
public struct LocalTrust: Sendable {
    public let host: String
#if canImport(Security)
    private let anchors: [SecCertificate]

    public init(host: String, certificate: URL?) {
        self.host = host.lowercased()
        anchors = certificate.flatMap { try? Data(contentsOf: $0) }.flatMap { SecCertificateCreateWithData(nil, $0 as CFData) }.map { [$0] } ?? []
    }

    public init(host: String, certificateData: Data) {
        self.host = host.lowercased()
        anchors = SecCertificateCreateWithData(nil, certificateData as CFData).map { [$0] } ?? []
    }

    public var hasAnchor: Bool { !anchors.isEmpty }

    // nil: not this trust's host; let the system decide.
    public func evaluate(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)? {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust, space.host.lowercased() == host,
              let trust = space.serverTrust else { return nil }
        guard !anchors.isEmpty else { return (.cancelAuthenticationChallenge, nil) }
        SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
        SecTrustSetAnchorCertificates(trust, anchors as CFArray)
        SecTrustSetAnchorCertificatesOnly(trust, true)
        var error: CFError?
        return SecTrustEvaluateWithError(trust, &error) ? (.useCredential, URLCredential(trust: trust)) : (.cancelAuthenticationChallenge, nil)
    }
#else
    // Linux (logic tests on the PC) has no Security framework to pin the bundled CA, so the
    // PC's host is refused rather than trusted some other way; other hosts get default handling.
    private let anchorCount: Int

    public init(host: String, certificate: URL?) {
        self.host = host.lowercased()
        anchorCount = certificate.flatMap { try? Data(contentsOf: $0) }.map { $0.isEmpty ? 0 : 1 } ?? 0
    }

    public init(host: String, certificateData: Data) {
        self.host = host.lowercased()
        anchorCount = certificateData.isEmpty ? 0 : 1
    }

    public var hasAnchor: Bool { anchorCount > 0 }

    public func evaluate(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)? {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == "NSURLAuthenticationMethodServerTrust", space.host.lowercased() == host else { return nil }
        return (.cancelAuthenticationChallenge, nil)
    }
#endif
}
