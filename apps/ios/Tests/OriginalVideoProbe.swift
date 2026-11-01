// Separate, temporary device-only codec check. No product-app storage or UI automation.
import UIKit
import AVFoundation

@main
@MainActor
final class OriginalVideoProbe: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    private var decoder: (any ViewerDecoder)?
    private var timer: Timer?
    private var tick = 0
    private var samples: [[String: Any]] = []
    private var failure = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private let output = URL.documentsDirectory.appendingPathComponent("decoder-probe.json")

    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard let at = CommandLine.arguments.firstIndex(of: "-original-url"), CommandLine.arguments.count > at + 1,
              let url = URL(string: CommandLine.arguments[at + 1]) else { return false }
        application.isIdleTimerDisabled = true
        backgroundTask = application.beginBackgroundTask(withName: "Original video codec check")
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        let root = UIViewController()
        root.view.backgroundColor = .black
        window = UIWindow(frame: UIScreen.main.bounds)
        window?.rootViewController = root
        window?.makeKeyAndVisible()
        let surface = UIView(frame: root.view.bounds)
        surface.backgroundColor = .black
        surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        root.view.addSubview(surface)
        let video = ViewerVideo(["filename": "original-codec-probe.mp4", "provider": "bunkr", "videoCodec": "av1", "duration": 412.270295])!
        Task {
        decoder = await ViewerDecoders.make(source: MediaSource(url: url, kind: "mp4"), video: video, surface: surface, start: 0,
                                     changed: {}, failed: { [weak self] in self?.failure = true })
        (decoder as? VLCVideoDecoder)?.beginDiagnostics(at: URL.documentsDirectory.appendingPathComponent("decoder-vlc.log"))
        decoder?.muted = true
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
        }
        return true
    }

    private func sample() {
        tick += 1
        var sample = decoder?.evidence ?? [:]
        sample["second"] = tick
        sample["thermalState"] = ProcessInfo.processInfo.thermalState.rawValue
        sample["appState"] = UIApplication.shared.applicationState.rawValue
        samples.append(sample)
        if decoder?.playing == true && decoder?.hasPicture == true { failure = false }
        if tick == 3 { decoder?.play() }
        if tick == 10 { decoder?.pause() }
        if tick == 12 { decoder?.seek(120) }
        if tick == 14 { decoder?.play() }
        if tick == 18 { decoder?.setVideoEnabled(false) }
        if tick == 21 { decoder?.setVideoEnabled(true) }
        if tick == 25 { decoder?.seek(410.27) }
        if tick == 28 { decoder?.play() }
        if tick >= 30 {
            decoder?.stop(); timer?.invalidate(); timer = nil
            UIApplication.shared.isIdleTimerDisabled = false
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        let report: [String: Any] = ["complete": tick >= 30, "decoderFailed": failure, "samples": samples,
                                    "device": UIDevice.current.model, "os": UIDevice.current.systemVersion]
        if let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: output, options: .atomic)
        }
        if tick >= 30 && backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }
}
