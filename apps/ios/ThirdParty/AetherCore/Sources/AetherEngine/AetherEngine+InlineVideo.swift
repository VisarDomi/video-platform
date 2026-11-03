import Foundation

extension AetherEngine {
    /// Host-owned inline surface: stop feeding video while retaining audio/time.
    public func setInlineVideoEnabled(_ enabled: Bool) {
        softwareHost?.preservesPictureOnVideoResume = true
        if enabled { softwareHost?.exitBackgroundAudioOnly() }
        else { softwareHost?.enterBackgroundAudioOnly() }
    }
    public var inlineAudioClock: Double? { softwareHost?.inlineAudioClock }
    /// The host uses this only after a successful load. HardwareVideoDecoder
    /// requires a real hardware session, so software fallback cannot report true.
    public var inlineHardwareDecoder: Bool? {
        guard playbackBackend == .software else { return nil }
        return softwareHost?.usesHardwareVideoDecoder
    }
    public static var inlineRetiringDecoderCount: Int { InlineDecoderRetirement.count }

    public struct InlineRenderStatistics: Sendable {
        public let total: Int
        public let dropped: Int
        public let corrupted: Int
    }

    public func inlineRenderStatistics() async -> InlineRenderStatistics? {
        guard let host = softwareHost, let metrics = await host.loadRenderMetrics(),
              softwareHost === host else { return nil }
        return InlineRenderStatistics(total: metrics.total, dropped: metrics.dropped, corrupted: metrics.corrupted)
    }
}
