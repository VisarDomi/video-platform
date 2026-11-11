import Foundation

extension AetherEngine {
    /// Host-owned inline surface: stop feeding video while retaining audio/time.
    public func setInlineVideoEnabled(_ enabled: Bool) {
        softwareHost?.preservesPictureOnVideoResume = true
        if enabled { softwareHost?.exitBackgroundAudioOnly() }
        else { softwareHost?.enterBackgroundAudioOnly() }
    }
    public var inlineAudioClock: Double? { softwareHost?.inlineAudioClock }

    /// Seeks and saved start positions land on keyframes (`InlineKeyframeLanding`). Set before
    /// the first load; read when a session opens.
    public nonisolated static var inlineKeyframeSeeks: Bool {
        get { InlineKeyframeLanding.enabled }
        set { InlineKeyframeLanding.enabled = newValue }
    }

    /// One seek of a gesture that began at `origin`. False when the picture already showing is
    /// the nearest one the decoder can give and nothing was sought.
    @discardableResult
    public func inlineSeek(to seconds: Double, from origin: Double) async -> Bool {
        softwareHost?.inlineSeekOrigin = origin
        if softwareHost?.inlineSeekStays(forSession: seconds) == true { return false }
        await seek(to: seconds, exact: false)
        return true
    }
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
