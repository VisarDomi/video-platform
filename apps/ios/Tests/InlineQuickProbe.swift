import UIKit
import AVFoundation
import AetherEngine

@main @MainActor
final class OriginalVideoProbe: UIResponder, UIApplicationDelegate, ViewerUnitDelegate {
    var window: UIWindow?
    private let unit = ViewerUnit()
    private let output = URL.documentsDirectory.appendingPathComponent("inline-quick.json")
    private var codec: String { CommandLine.arguments.contains("-av1-check") ? "av1" : "vp9" }
    private var filename: String { "inline-\(codec)-opus.webm" }
    private var url: URL { URL.documentsDirectory.appendingPathComponent(filename) }
    private let clipDuration = 20.008
    private var samples: [[String: Any]] = []
    private var resolutions = 0
    private var teardownMs: [Double] = []
    private var teardownPhases: [String] = []
    private var heartbeat: Timer?
    private var lastHeartbeat = 0.0
    private var worstGap = 0.0
    private var measuringUntil = 0.0
    private var currentPhase = "launch"
    private var observedStalls: [[String: Any]] = []
    private var begun = false
    private var runID = ""
    private var delaySource = false
    private var cancelledSources = 0
    private var lifecycleEvents: [[String: Any]] = []
    func noteLifecycle(_ name: String) {
        lifecycleEvents.append(["event": name, "time": CACurrentMediaTime(),
            "appState": UIApplication.shared.applicationState.rawValue,
            "sceneState": window?.windowScene?.activationState.rawValue ?? -99])
        write(complete: false, error: nil)
    }
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        if let at = CommandLine.arguments.firstIndex(of: "-probe-run") { runID = CommandLine.arguments[at+1] }
        EngineLog.handler = { line in FileHandle.standardError.write(Data((line+"\n").utf8)) }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        write(complete: false, error: nil)
        return true
    }
    func application(_ application:UIApplication,configurationForConnecting session:UISceneSession,options:UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name:"Inline decoder check",sessionRole:session.role)
        configuration.delegateClass = InlineProbeScene.self
        return configuration
    }
    func connect(_ scene:UIWindowScene) -> UIWindow {
        let root = UIViewController(); root.view.backgroundColor = .black
        let created = UIWindow(windowScene:scene)
        created.rootViewController = root; created.makeKeyAndVisible(); window = created
        unit.delegate = self; unit.view.frame = root.view.bounds; unit.view.autoresizingMask = [.flexibleWidth,.flexibleHeight]
        root.view.addSubview(unit.view)
        return created
    }
    func applicationDidBecomeActive(_ application: UIApplication) {
        beginCheck()
    }
    func beginCheck() {
        guard window != nil else { return }
        guard !begun else { return }; begun = true
        lastHeartbeat = CACurrentMediaTime()
        heartbeat = Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }; let now = CACurrentMediaTime()
                if now <= self.measuringUntil { self.worstGap = max(self.worstGap,(now-self.lastHeartbeat)*1000) }
                if now-self.lastHeartbeat > 0.1, UIApplication.shared.applicationState == .active {
                    self.observedStalls.append(["phase":self.currentPhase,"gapMs":(now-self.lastHeartbeat)*1000])
                }
                self.lastHeartbeat = now
            }
        }
        Task { await check() }
    }
    private func wait(_ label: String, seconds: Double = 8, until predicate: () -> Bool) async throws {
        currentPhase = label
        let deadline = CACurrentMediaTime()+seconds
        while !predicate() {
            if CACurrentMediaTime() > deadline { throw NSError(domain: label, code: 1) }
            try await Task.sleep(for: .milliseconds(40))
        }
        record(label)
    }
    private func record(_ label: String) {
        currentPhase = label
        var row = unit.playbackEvidence; row["phase"] = label; row["unitTime"] = unit.snapshot().currentTime
        row["sampleTime"] = CACurrentMediaTime()
        row["appState"] = UIApplication.shared.applicationState.rawValue
        row["sceneState"] = window?.windowScene?.activationState.rawValue ?? -99
        row["endedBeforePlayout"] = (row["ended"] as? Bool == true) && nativeTime() < (row["duration"] as? Double ?? 0)-0.1
        row["sourceResolutions"] = resolutions; samples.append(row)
        write(complete:false,error:nil)
    }
    private func clear() {
        let began = CACurrentMediaTime(); lastHeartbeat = began; measuringUntil = began+1
        unit.clear(); teardownMs.append((CACurrentMediaTime()-began)*1000)
        teardownPhases.append(currentPhase)
    }
    private func nativeTime() -> Double { unit.playbackEvidence["nativeTime"] as? Double ?? -1 }
    private func check() async {
        do {
            record("prewarm Settings")
            let warmOpened = await UIApplication.shared.open(URL(string:UIApplication.openSettingsURLString)!,options:[:])
            record(warmOpened ? "warm Settings accepted" : "warm Settings refused")
            guard warmOpened else { throw NSError(domain:"Warm Settings opening refused",code:1) }
            try await wait("warm background entered",seconds:90) { window?.windowScene?.activationState == .background }
            record("await warm foreground")
            try await wait("warm foreground entered",seconds:90) { window?.windowScene?.activationState == .foregroundActive }
            let video = ViewerVideo(["filename":filename,"provider":"bunkr","videoCodec":codec,"duration":clipDuration])!
            // An opening that is superseded cancels its source and closes its decoder.
            delaySource = true
            unit.load(video,start:0,play:true)
            try await Task.sleep(for:.milliseconds(40))
            clear()
            try await wait("superseded source cancelled",seconds:2) { cancelledSources == 1 }
            try await Task.sleep(for:.milliseconds(1100))
            delaySource = false
            currentPhase = "cancelled decoder opening"
            unit.load(video,start:0,play:true)
            try await Task.sleep(for:.milliseconds(20))
            clear()
            try await wait("superseded decoder closed",seconds:4) {
                FFmpegVideoDecoder.preparingCount == 0 && AetherEngine.inlineRetiringDecoderCount == 0
            }
            try await Task.sleep(for:.milliseconds(1100))
            // A paused neighbour holds no decoder: it shows the keyframe it will open on.
            currentPhase = "paused neighbour"
            unit.load(video,start:0,play:false)
            try await wait("neighbour still",seconds:12) { unit.showsPoster }
            guard !unit.hasPicture, FFmpegVideoDecoder.preparingCount == 0, unit.playbackEvidence["engine"] == nil else {
                throw NSError(domain:"A paused neighbour opened a decoder",code:1)
            }
            record("await picture capture")
            try await wait("picture captured",seconds:15) {
                FileManager.default.fileExists(atPath: URL.documentsDirectory.appendingPathComponent("picture-\(runID).ready").path)
            }
            unit.play()
            try await wait("playing") { unit.hasPicture && nativeTime() > 0.3 }
            guard !unit.showsPoster else { throw NSError(domain:"The still stayed over the player's picture",code:1) }
            guard unit.playbackEvidence["audioDelivery"] as? String == "decoded" else { throw NSError(domain:"Missing decoded audio",code:1) }
            unit.pause(); let parked = nativeTime()
            try await Task.sleep(for:.milliseconds(400)); record("pause holds")
            guard abs(nativeTime()-parked)<0.15 else { throw NSError(domain:"Pause drift",code:1) }
            // A drag: its seeks show keyframes (wherever the clip keeps them), each one drawn
            // under the pause, never behind the place the drag began, and the video stays still
            // until the finger lifts.
            let frames = unit.frameSerial
            unit.seek(parked+2.7,resume:false)
            try await wait("drag shows a keyframe") { unit.frameSerial != frames && nativeTime()>parked+1 }
            let first = nativeTime()
            unit.seek(11.5,resume:false)
            try await wait("drag moves on to a later keyframe") { nativeTime()>first+0.5 && nativeTime()<=11.55 }
            let far = nativeTime()
            // The finger comes back: an earlier keyframe, still not behind where the drag began.
            unit.seek(6.2,resume:false)
            try await wait("drag comes back to an earlier keyframe") { nativeTime()<far-0.5 && nativeTime()>=first-0.05 }
            let landed = nativeTime()
            try await Task.sleep(for:.milliseconds(400)); record("drag holds still")
            guard abs(nativeTime()-landed)<0.05 else { throw NSError(domain:"A drag played on",code:1) }
            unit.play(); try await wait("seek playback") { nativeTime()>landed+0.2 }
            unit.setVideoEnabled(false)
            record("await background")
            let opened = await UIApplication.shared.open(URL(string:UIApplication.openSettingsURLString)!,options:[:])
            record(opened ? "settings opening accepted" : "settings opening refused")
            guard opened else { throw NSError(domain:"Settings opening refused",code:1) }
            try await wait("background entered",seconds:8) { window?.windowScene?.activationState == .background }
            let audio = nativeTime()
            try await wait("video disabled clock advances",seconds:3) { nativeTime()>audio+0.3 }
            record("await foreground")
            try await wait("foreground entered",seconds:8) { window?.windowScene?.activationState == .foregroundActive }
            let returnClock = nativeTime(), returnWall = CACurrentMediaTime()
            unit.setVideoEnabled(true)
            try await wait("video returns",seconds:6) {
                (unit.playbackEvidence["presentedSourceTime"] as? Double ?? -1) >= returnClock && unit.hasPicture
            }
            let elapsed = CACurrentMediaTime()-returnWall
            guard nativeTime()-returnClock >= elapsed-0.25 else { throw NSError(domain:"Video return interrupted audio clock",code:1) }
            record("return clock continued")
            clear()
            try await Task.sleep(for:.milliseconds(1100))
            // A saved position shows its keyframe as a still, and opens on that keyframe.
            currentPhase = "restored neighbour"
            unit.load(video,start:2.7,play:false)
            try await wait("restored still",seconds:12) { unit.showsPoster && abs(unit.snapshot().currentTime-2.7)<0.01 }
            unit.play()
            try await wait("saved restore") { unit.hasPicture && nativeTime()>=0 }
            guard nativeTime() <= 2.75 else { throw NSError(domain:"A saved position opened after itself",code:1) }
            record("before tail seek")
            unit.seek(clipDuration-2,resume:true)
            record("tail seek requested")
            try await wait("queued tail playing",seconds:7) { nativeTime() > clipDuration-1.75 }
            unit.pause(); let tailClock = nativeTime()
            try await Task.sleep(for:.milliseconds(350)); record("queued tail pause holds")
            guard unit.playbackEvidence["ended"] as? Bool != true, abs(nativeTime()-tailClock)<0.1 else {
                throw NSError(domain:"Queued tail ended while paused",code:1)
            }
            unit.play()
            try await wait("EOF",seconds:5) { unit.playbackEvidence["ended"] as? Bool == true }
            let end = nativeTime(); unit.resume(liveEdge:false); unit.play()
            try await Task.sleep(for:.milliseconds(350)); record("EOF stays stopped")
            guard unit.playbackEvidence["ended"] as? Bool == true, abs(nativeTime()-end)<0.1 else { throw NSError(domain:"EOF restarted",code:1) }
            unit.seek(0.4,resume:true)
            try await wait("explicit replay") { nativeTime()>0.6 && unit.hasPicture }
            // The queued-tail pause has enough remaining audio to survive a
            // coarse clock tick. Separately regress the half-second auto-rewind.
            unit.seek(clipDuration-0.4,resume:true)
            try await wait("near-end seek landed",seconds:7) { nativeTime()>clipDuration-0.5 }
            try await Task.sleep(for:.milliseconds(700)); record("near-end playback stays near end")
            guard nativeTime()>clipDuration-0.5 else { throw NSError(domain:"Near-end playback rewound",code:1) }
            clear()
            try await wait("retirement complete",seconds:4) { AetherEngine.inlineRetiringDecoderCount == 0 }
            try await Task.sleep(for:.milliseconds(1100))
            guard teardownMs.max() ?? 0 < 50, worstGap < 100 else { throw NSError(domain:"Teardown blocked UI",code:1) }
            // Unknown codec metadata must still use the established fallback.
            // Exercise it with both FFmpeg ABIs loaded in the same executable.
            let fallback = ViewerVideo(["filename":"fallback.webm","provider":"bunkr","duration":clipDuration])!
            unit.load(fallback,start:0,play:true)
            try await wait("fallback picture") { unit.hasPicture }
            record("fallback await picture capture")
            try await wait("fallback picture captured",seconds:15) {
                FileManager.default.fileExists(atPath: URL.documentsDirectory.appendingPathComponent("fallback-\(runID).ready").path)
            }
            guard unit.playbackEvidence["engine"] as? String == "VLCKit" else {
                throw NSError(domain:"Missing legacy decoder fallback",code:1)
            }
            try await wait("fallback playing") { nativeTime()>0.3 }
            unit.pause(); let fallbackClock = nativeTime()
            try await Task.sleep(for:.milliseconds(350)); record("fallback paused")
            guard abs(nativeTime()-fallbackClock)<0.15 else { throw NSError(domain:"Fallback pause drift",code:1) }
            clear()
            try await wait("fallback retirement complete",seconds:4) { VLCVideoDecoder.retiringCount == 0 }
            write(complete:true,error:nil)
        } catch { record("failed"); clear(); write(complete:true,error:String(describing:error)) }
        heartbeat?.invalidate(); heartbeat = nil
        try? AVAudioSession.sharedInstance().setActive(false, options:.notifyOthersOnDeactivation)
    }
    private func write(complete: Bool,error:String?) {
        var value:[String:Any] = ["runID":runID,"complete":complete,"samples":samples,"lifecycleEvents":lifecycleEvents,"teardownMs":teardownMs,"teardownPhases":teardownPhases,"worstGapMs":worstGap,"observedStalls":observedStalls,"retiringDecoders":AetherEngine.inlineRetiringDecoderCount]
        if let error { value["error"] = error }
        if let data = try? JSONSerialization.data(withJSONObject:value,options:[.prettyPrinted,.sortedKeys]) { try? data.write(to:output,options:.atomic) }
    }
    func unitSource(_ video:ViewerVideo) async throws -> MediaSource {
        resolutions += 1
        if delaySource {
            do { try await Task.sleep(for:.seconds(2)) }
            catch { cancelledSources += 1; throw error }
        }
        return MediaSource(url:url,kind:"file")
    }
    func unitAsset(_ source:MediaSource,for video:ViewerVideo) async -> AVURLAsset { AVURLAsset(url:source.url) }
    func unitTime(_ unit:ViewerUnit,_ snapshot:TimelineSnapshot) {}
    func unitLiveChanged(_ unit:ViewerUnit,_ live:Bool) {}
    func unitMutedChanged(_ unit:ViewerUnit,_ muted:Bool) {}
    func unitUnavailable(_ unit:ViewerUnit) {}
    func unitGeometryChanged(_ unit:ViewerUnit) {}
    func unitNeedsLogin(_ unit:ViewerUnit) {}
    func application(_ application:UIApplication,open url:URL,options:[UIApplication.OpenURLOptionsKey:Any] = [:]) -> Bool { url.scheme == "inline-codec-probe" }
}

@MainActor
final class InlineProbeScene: UIResponder, UIWindowSceneDelegate {
    var window:UIWindow?
    func scene(_ scene:UIScene,willConnectTo session:UISceneSession,options:UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene,
              let app = UIApplication.shared.delegate as? OriginalVideoProbe else { return }
        window = app.connect(scene)
    }
    func sceneDidBecomeActive(_ scene:UIScene) {
        let app = UIApplication.shared.delegate as? OriginalVideoProbe
        app?.noteLifecycle("scene active")
        app?.beginCheck()
    }
    func sceneDidEnterBackground(_ scene:UIScene) {
        (UIApplication.shared.delegate as? OriginalVideoProbe)?.noteLifecycle("scene background")
    }
    func scene(_ scene:UIScene,openURLContexts contexts:Set<UIOpenURLContext>) {
        (UIApplication.shared.delegate as? OriginalVideoProbe)?.noteLifecycle("return URL delivered")
    }
}
