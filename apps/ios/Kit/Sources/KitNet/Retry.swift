import Foundation

// When a failed request is tried again. The apps' shared rule (manga, gallery and Ytb
// Models.swift): idempotent reads retry on lost connectivity and on 408/429/5xx (honouring
// Retry-After), backing off from 1 s to 30 s, until cancelled. Writes and PC calls do not
// retry: they are `.never`.
public struct RetryPolicy: Sendable {
    public var maxAttempts: Int?
    public var firstDelay: Double
    public var maxDelay: Double
    public var hostMissingAttempts: Int?

    public static let never = RetryPolicy(maxAttempts: 1)
    public static let reads = RetryPolicy()

    public init(maxAttempts: Int? = nil, firstDelay: Double = 1, maxDelay: Double = 30, hostMissingAttempts: Int? = nil) {
        self.maxAttempts = maxAttempts
        self.firstDelay = firstDelay
        self.maxDelay = maxDelay
        self.hostMissingAttempts = hostMissingAttempts
    }

    public static let retryableStatuses: Set<Int> = [408, 429, 500, 502, 503, 504]
    static let transientCodes: Set<URLError.Code> = [.notConnectedToInternet, .networkConnectionLost, .timedOut,
                                                     .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed]

    public func run<T>(isolation: isolated (any Actor)? = #isolation, _ operation: () async throws -> T) async throws -> T {
        var delay = firstDelay
        var attempt = 0
        while true {
            try Task.checkCancellation()
            attempt += 1
            do { return try await operation() }
            catch {
                try Task.checkCancellation()
                guard let wait = retryDelay(for: error, attempt: attempt, backoff: delay) else { throw error }
                try await Task.sleep(for: .seconds(wait))
                delay = min(delay * 2, maxDelay)
            }
        }
    }

    // nil: give up and throw.
    func retryDelay(for error: Error, attempt: Int, backoff: Double) -> Double? {
        if let maxAttempts, attempt >= maxAttempts { return nil }
        if let network = error as? URLError {
            guard Self.transientCodes.contains(network.code) else { return nil }
            if let hostMissingAttempts, [.cannotFindHost, .dnsLookupFailed].contains(network.code), attempt >= hostMissingAttempts { return nil }
            return backoff
        }
        if let status = error as? HTTPStatusError, Self.retryableStatuses.contains(status.status) {
            return max(backoff, status.retryAfter ?? 0)
        }
        return nil
    }
}

public struct HTTPStatusError: LocalizedError, Sendable {
    public let status: Int
    public let url: URL?
    public let retryAfter: Double?
    public let body: Data

    public init(status: Int, url: URL?, retryAfter: Double? = nil, body: Data = Data()) {
        self.status = status
        self.url = url
        self.retryAfter = retryAfter
        self.body = body
    }

    public var errorDescription: String? { "HTTP \(status)" + (url.map { " for \($0.host ?? $0.absoluteString)" } ?? "") }

    static func retryAfter(_ response: HTTPURLResponse) -> Double? {
        guard let header = response.value(forHTTPHeaderField: "Retry-After") else { return nil }
        if let seconds = Double(header) { return seconds.isFinite ? max(0, seconds) : nil }
        let format = DateFormatter()
        format.locale = Locale(identifier: "en_US_POSIX")
        format.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return format.date(from: header).map { max(0, $0.timeIntervalSinceNow) }
    }
}
