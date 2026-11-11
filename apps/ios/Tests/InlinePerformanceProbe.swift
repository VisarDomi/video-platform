// Simulator-only controlled playback benchmark. Never a product or phone target.
import UIKit
import AVFoundation
import AetherEngine
import Darwin

@main @MainActor
final class OriginalVideoProbe: UIResponder, UIApplicationDelegate, ViewerUnitDelegate {
    var window: UIWindow?
    private let unit = ViewerUnit()
    private var begun = false
    private var samples: [[String: Any]] = []
    private var runID = ""
    private var codec = "av1"
    private var source: URL { URL.documentsDirectory.appendingPathComponent("performance.webm") }
    private var output: URL { URL.documentsDirectory.appendingPathComponent("inline-performance.json") }
    private var heartbeats: Timer?
    private var previousTick = 0.0
    private var worstGapMs = 0.0

    private func cpu() -> Double {
        var value = rusage(); getrusage(RUSAGE_SELF, &value)
        return Double(value.ru_utime.tv_sec + value.ru_stime.tv_sec)
            + Double(value.ru_utime.tv_usec + value.ru_stime.tv_usec) / 1_000_000
    }
    private func peakResidentBytes() -> Int64 {
        var value = rusage(); getrusage(RUSAGE_SELF, &value)
        return Int64(value.ru_maxrss)
    }
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let args = CommandLine.arguments
        if let at = args.firstIndex(of: "-probe-run") { runID = args[at + 1] }
        if let at = args.firstIndex(of: "-codec") { codec = args[at + 1] }
        EngineLog.handler = { line in FileHandle.standardError.write(Data((line + "\n").utf8)) }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        write(complete: false)
        return true
    }
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Inline performance check", sessionRole: session.role)
        configuration.delegateClass = InlineProbeScene.self
        return configuration
    }
    func connect(_ scene: UIWindowScene) -> UIWindow {
        let root = UIViewController(); root.view.backgroundColor = .black
        let window = UIWindow(windowScene: scene); window.rootViewController = root
        window.makeKeyAndVisible(); self.window = window
        unit.delegate = self; unit.view.frame = root.view.bounds
        unit.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.view.addSubview(unit.view)
        return window
    }
    func begin() {
        guard !begun else { return }; begun = true
        previousTick = CACurrentMediaTime()
        heartbeats = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                let now = CACurrentMediaTime()
                self.worstGapMs = max(self.worstGapMs, (now - self.previousTick) * 1_000)
                self.previousTick = now
            }
        }
        Task { await run() }
    }
    private func sample(_ phase: String, wall: Double, cpu: Double) {
        var row = unit.playbackEvidence
        row["phase"] = phase; row["wallSeconds"] = CACurrentMediaTime() - wall
        row["cpuSeconds"] = self.cpu() - cpu; row["peakResidentBytes"] = peakResidentBytes()
        row["worstHeartbeatMs"] = worstGapMs; samples.append(row)
        write(complete: false)
    }
    private func run() async {
        do {
            var wall = CACurrentMediaTime(), usedCPU = cpu()
            try await Task.sleep(for: .seconds(2))
            sample("empty baseline", wall: wall, cpu: usedCPU)
            let video = ViewerVideo(["filename": "performance.webm", "provider": "bunkr", "videoCodec": codec,
                                     "duration": 20.008, "displayWidth": 1280.0, "displayHeight": 720.0])!
            wall = CACurrentMediaTime(); usedCPU = cpu(); worstGapMs = 0
            // Opened, shown and paused: the state of the video the user stopped on.
            unit.load(video, start: 0, play: true)
            let deadline = CACurrentMediaTime() + 20
            while !unit.hasPicture {
                guard CACurrentMediaTime() < deadline else { throw NSError(domain: "No paused picture", code: 1) }
                try await Task.sleep(for: .milliseconds(20))
            }
            unit.pause()
            sample("paused picture ready", wall: wall, cpu: usedCPU)
            wall = CACurrentMediaTime(); usedCPU = cpu(); worstGapMs = 0
            try await Task.sleep(for: .seconds(3))
            sample("paused idle", wall: wall, cpu: usedCPU)
            unit.play()
            // Exclude the startup preroll from steady-state playback.
            try await Task.sleep(for: .seconds(1))
            sample("playing start", wall: CACurrentMediaTime(), cpu: cpu())
            wall = CACurrentMediaTime(); usedCPU = cpu(); worstGapMs = 0
            try await Task.sleep(for: .seconds(6))
            sample("playing end", wall: wall, cpu: usedCPU)
            unit.pause()
            wall = CACurrentMediaTime(); usedCPU = cpu(); worstGapMs = 0
            try await Task.sleep(for: .seconds(3))
            sample("paused after playback", wall: wall, cpu: usedCPU)
            unit.clear()
            let stopped = CACurrentMediaTime() + 5
            while AetherEngine.inlineRetiringDecoderCount > 0 || VLCVideoDecoder.retiringCount > 0 {
                guard CACurrentMediaTime() < stopped else { throw NSError(domain: "Decoder still retiring", code: 1) }
                try await Task.sleep(for: .milliseconds(20))
            }
            write(complete: true)
        } catch { unit.clear(); write(complete: true, error: String(describing: error)) }
        heartbeats?.invalidate(); heartbeats = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    private func write(complete: Bool, error: String? = nil) {
        var report: [String: Any] = ["runID": runID, "complete": complete, "codec": codec,
                                   "forcedLegacy": CommandLine.arguments.contains("-force-vlc"), "samples": samples,
                                   "retiringDecoders": AetherEngine.inlineRetiringDecoderCount + VLCVideoDecoder.retiringCount]
        if let error { report["error"] = error }
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: output, options: .atomic)
        }
    }
    func unitSource(_ video: ViewerVideo) async throws -> MediaSource { MediaSource(url: source, kind: "file") }
    func unitAsset(_ source: MediaSource, for video: ViewerVideo) async -> AVURLAsset { AVURLAsset(url: source.url) }
    func unitTime(_ unit: ViewerUnit, _ snapshot: TimelineSnapshot) {}
    func unitLiveChanged(_ unit: ViewerUnit, _ isLive: Bool) {}
    func unitMutedChanged(_ unit: ViewerUnit, _ muted: Bool) {}
    func unitUnavailable(_ unit: ViewerUnit) {}
    func unitGeometryChanged(_ unit: ViewerUnit) {}
    func unitNeedsLogin(_ unit: ViewerUnit) {}
}

@MainActor
final class InlineProbeScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene,
              let app = UIApplication.shared.delegate as? OriginalVideoProbe else { return }
        window = app.connect(scene)
    }
    func sceneDidBecomeActive(_ scene: UIScene) {
        (UIApplication.shared.delegate as? OriginalVideoProbe)?.begin()
    }
}
