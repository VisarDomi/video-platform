// Temporary physical codec check using the product's real ViewerUnit, with its own container.
import UIKit
import AVFoundation

@main
@MainActor
final class OriginalVideoProbe: UIResponder, UIApplicationDelegate, ViewerUnitDelegate {
    var window: UIWindow?
    private let unit = ViewerUnit()
    private var timer: Timer?
    private var video: ViewerVideo?
    private var sourceURL: URL?
    private var started = false
    private var tick = 0
    private var resolutions = 0
    private var savedTime = 0.0
    private var samples: [[String: Any]] = []
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var logging = false
    private var runID = ""
    private var testDuration = 412.270295
    private var teardownMilliseconds: [Double] = []
    private var heartbeat: Timer?
    private var lastHeartbeat = 0.0
    private var teardownWindowUntil = 0.0
    private var teardownWorstGapMs = 0.0
    private let output = URL.documentsDirectory.appendingPathComponent("decoder-probe.json")

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard let at = CommandLine.arguments.firstIndex(of: "-original-url"), CommandLine.arguments.count > at + 1 else { return false }
        let argument = CommandLine.arguments[at + 1]
        guard let url = argument == "probe-local" ? URL.documentsDirectory.appendingPathComponent("original.mp4") : URL(string: argument) else { return false }
        sourceURL = url
        if let index = CommandLine.arguments.firstIndex(of: "-probe-run"), CommandLine.arguments.count > index + 1 { runID = CommandLine.arguments[index + 1] }
        let pending: [String: Any] = ["runID": runID, "complete": false, "transportReady": false, "samples": []]
        if let data = try? JSONSerialization.data(withJSONObject: pending) { try? data.write(to: output, options: .atomic) }
        var codec = "av1"
        var filename = "original-codec-probe.mp4"
        if let index = CommandLine.arguments.firstIndex(of: "-filename"), CommandLine.arguments.count > index + 1 { filename = CommandLine.arguments[index + 1] }
        if let index = CommandLine.arguments.firstIndex(of: "-codec"), CommandLine.arguments.count > index + 1 { codec = CommandLine.arguments[index + 1] }
        if let index = CommandLine.arguments.firstIndex(of: "-duration"), CommandLine.arguments.count > index + 1,
           let duration = Double(CommandLine.arguments[index + 1]), duration > 150 { testDuration = duration }
        video = ViewerVideo(["filename": filename, "provider": "bunkr", "videoCodec": codec, "duration": testDuration,
                             "media": ["url": url.absoluteString, "kind": "mp4"]])
        application.isIdleTimerDisabled = true
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        let root = UIViewController(); root.view.backgroundColor = .black
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = root; window?.makeKeyAndVisible()
        unit.view.frame = root.view.bounds
        unit.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.view.addSubview(unit.view)
        unit.delegate = self
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        guard !started, let video else { return }
        started = true
        Task {
            // Trigger and wait for the app's one-time Local Network approval before
            // measuring decoding. A denied socket is not a failed decoder test.
            guard let sourceURL else { return }
            var ready = sourceURL.isFileURL
            for _ in 0..<20 where !ready {
                var request = URLRequest(url: sourceURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 3)
                request.httpMethod = "HEAD"
                if let (_, response) = try? await URLSession.shared.data(for: request),
                   (response as? HTTPURLResponse)?.statusCode == 200 { ready = true; break }
                try? await Task.sleep(for: .seconds(1))
            }
            guard ready else {
                let report: [String: Any] = ["runID": runID, "complete": true, "transportReady": false, "samples": []]
                if let data = try? JSONSerialization.data(withJSONObject: report) { try? data.write(to: output, options: .atomic) }
                return
            }
            backgroundTask = application.beginBackgroundTask(withName: "Original video codec check")
            lastHeartbeat = CACurrentMediaTime()
            heartbeat = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let now = CACurrentMediaTime()
                    if now <= self.teardownWindowUntil { self.teardownWorstGapMs = max(self.teardownWorstGapMs, (now - self.lastHeartbeat) * 1000) }
                    self.lastHeartbeat = now
                }
            }
            // Returning while an input is still opening must release it too,
            // including a late factory result from a recycled unit.
            for _ in 0..<3 {
                unit.load(video, start: 0, play: true)
                try? await Task.sleep(for: .milliseconds(20))
                clearMeasured()
            }
            unit.load(video, start: 0, play: false)
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.sample() }
            }
        }
    }

    private func sample() {
        tick += 1
        if !logging { logging = unit.beginDecoderDiagnostics(at: URL.documentsDirectory.appendingPathComponent("decoder-vlc.log")) }
        var sample = unit.playbackEvidence
        sample["second"] = tick
        sample["appState"] = UIApplication.shared.applicationState.rawValue
        sample["thermalState"] = ProcessInfo.processInfo.thermalState.rawValue
        sample["sourceResolutions"] = resolutions
        sample["savedTime"] = savedTime
        sample["unitTime"] = unit.snapshot().currentTime
        sample["muted"] = unit.muted
        samples.append(sample)
        if tick == 3 { unit.play() }
        if tick == 8 { unit.pause() }
        if tick == 10 { unit.seek(120, resume: false) }
        if tick == 12 { unit.play() }
        if tick == 16 { unit.setVideoEnabled(false) }
        if tick == 19 { unit.setVideoEnabled(true) }
        if tick == 23, let video {
            savedTime = unit.snapshot().currentTime
            clearMeasured(); logging = false
            unit.load(video, start: savedTime, play: true)
        }
        if tick == 28 { unit.seek(testDuration - 2, resume: true) }
        if tick == 33 { unit.resume(liveEdge: false); unit.play() }
        if tick == 35 { unit.seek(3, resume: true); logging = false }
        if tick == 40 { clearMeasured() }
        let complete = tick >= 41
        if complete {
            timer?.invalidate(); timer = nil
            heartbeat?.invalidate(); heartbeat = nil
            UIApplication.shared.isIdleTimerDisabled = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        let report: [String: Any] = ["runID": runID, "complete": complete, "transportReady": true, "samples": samples,
                                   "teardownMilliseconds": teardownMilliseconds, "retiringDecoders": VLCVideoDecoder.retiringCount,
                                   "teardownWorstGapMs": teardownWorstGapMs,
                                   "os": UIDevice.current.systemVersion]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) { try? data.write(to: output, options: .atomic) }
        if complete && backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask); backgroundTask = .invalid
        }
    }

    private func clearMeasured() {
        let start = CACurrentMediaTime()
        lastHeartbeat = start
        teardownWindowUntil = start + 1
        unit.clear()
        teardownMilliseconds.append((CACurrentMediaTime() - start) * 1000)
    }

    func unitSource(_ video: ViewerVideo) async throws -> MediaSource {
        resolutions += 1
        return MediaSource(url: sourceURL!, kind: "mp4")
    }
    func unitAsset(_ source: MediaSource, for video: ViewerVideo) async -> AVURLAsset { AVURLAsset(url: source.url) }
    func unitTime(_ unit: ViewerUnit, _ snapshot: TimelineSnapshot) {}
    func unitLiveChanged(_ unit: ViewerUnit, _ live: Bool) {}
    func unitMutedChanged(_ unit: ViewerUnit, _ muted: Bool) {}
    func unitGeometryChanged(_ unit: ViewerUnit) {}
    func unitUnavailable(_ unit: ViewerUnit) {}
    func unitNeedsLogin(_ unit: ViewerUnit) {}
}
