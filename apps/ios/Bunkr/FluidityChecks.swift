#if targetEnvironment(simulator)
import UIKit
import KitCore
import KitTestHooks
#if canImport(AetherEngine)
import AetherEngine
#endif

// Virtual-iPhone timing of the real list, viewer and units against the PC's original
// files: opening, scrubbing, jumping and moving to a neighbour. It records what the
// player reports at every display frame; it never changes playback policy and none of
// it exists in a phone build.
@MainActor
final class FluidityChecks {
    static let shared = FluidityChecks()
    private weak var list: VideoListController?
    private var link: CADisplayLink?
    private var origin = CACurrentMediaTime()
    private var previous = 0.0
    private var frame = 0
    private var samples: [[Any]] = []
    private var details: [[String: Any]] = []
    private var events: [[String: Any]] = []
    private var script: Timer?

    func install(_ list: VideoListController) {
        self.list = list
        #if canImport(AetherEngine)
        if ProcessInfo.processInfo.arguments.contains("-engine-log") {
            let origin = origin
            EngineLog.handler = { line in
                let stamp = String(format: "%9.1f ", (CACurrentMediaTime() - origin) * 1000)
                FileHandle.standardError.write(Data((stamp + line + "\n").utf8))
            }
        }
        #endif
        let hooks = TestHooks.shared
        hooks.register("fluidity-list") { [weak self] _ in self?.rows() ?? [:] }
        hooks.register("fluidity-progress") { [weak self] query in
            guard let self, let video = self.video(query) else { return ["error": "row"] }
            self.list?.progress.set(video.progressKey, Double(query["time"] ?? "") ?? 0)
            return ["time": self.list?.progress.time(video.progressKey) ?? -1]
        }
        hooks.register("fluidity-open") { [weak self] query in
            guard let self, let list = self.list, let row = Int(query["row"] ?? ""), list.videos.indices.contains(row) else { return ["error": "row"] }
            self.start()
            self.mark("open", ["row": row, "name": list.videos[row].filename, "codec": list.videos[row].videoCodec ?? ""])
            list.tableView(list.table, didSelectRowAt: IndexPath(row: row, section: 0))
            self.mark("open-returned")
            return self.state()
        }
        hooks.register("fluidity-seek") { [weak self] query in
            guard let self, let viewer = self.list?.viewer, let time = Double(query["time"] ?? "") else { return ["error": "viewer"] }
            let resume = query["resume"] != "0"
            self.mark("seek", ["time": time, "resume": resume])
            viewer.overlaySeek(time, resume: resume)
            return self.state()
        }
        // The upper-half drag: a seek per touch sample, then the finger lifts and playback continues.
        hooks.register("fluidity-scrub") { [weak self] query in
            guard let self, let viewer = self.list?.viewer, let from = Double(query["from"] ?? ""), let to = Double(query["to"] ?? "") else { return ["error": "viewer"] }
            let steps = max(1, Int(query["steps"] ?? "") ?? 45), seconds = (Double(query["ms"] ?? "") ?? 750) / 1000
            var step = 0
            self.mark("scrub-start", ["from": from, "to": to, "steps": steps])
            self.script?.invalidate()
            self.script = Timer.scheduledTimer(withTimeInterval: seconds / Double(steps), repeats: true) { [weak self] timer in
                MainActor.assumeIsolated {
                    guard let self else { timer.invalidate(); return }
                    step += 1
                    viewer.overlaySeek(from + (to - from) * Double(step) / Double(steps), resume: false)
                    guard step >= steps else { return }
                    timer.invalidate(); self.script = nil
                    self.mark("scrub-release", ["time": to])
                    self.units(viewer).active?.play()
                }
            }
            return ["scheduled": true]
        }
        // A finger moving the document by `delta` points, then lifting.
        hooks.register("fluidity-swipe") { [weak self] query in
            guard let self, let viewer = self.list?.viewer, let delta = Double(query["delta"] ?? "") else { return ["error": "viewer"] }
            let steps = max(1, Int(query["steps"] ?? "") ?? 18), seconds = (Double(query["ms"] ?? "") ?? 300) / 1000
            var step = 0
            self.mark("swipe-start", ["delta": delta])
            self.script?.invalidate()
            self.script = Timer.scheduledTimer(withTimeInterval: seconds / Double(steps), repeats: true) { [weak self] timer in
                MainActor.assumeIsolated {
                    guard let self else { timer.invalidate(); return }
                    step += 1
                    _ = viewer.checkFeedScroll(delta: CGFloat(delta / Double(steps)), end: step >= steps)
                    guard step >= steps else { return }
                    timer.invalidate(); self.script = nil
                    self.mark("swipe-release", ["name": viewer.currentVideo?.filename ?? ""])
                }
            }
            return ["scheduled": true]
        }
        hooks.register("fluidity-close") { [weak self] _ in
            self?.mark("close"); self?.list?.viewer?.close(); self?.mark("close-returned")
            return self?.state() ?? [:]
        }
        hooks.register("fluidity-state") { [weak self] _ in self?.state() ?? [:] }
        hooks.register("fluidity-samples") { [weak self] query in
            guard let self else { return [:] }
            let from = max(0, Int(query["from"] ?? "") ?? 0)
            let slice = Array(self.samples.dropFirst(from).prefix(1500))
            return ["from": from, "samples": slice, "total": self.samples.count, "events": self.events, "details": from == 0 ? self.details : []]
        }
        hooks.register("fluidity-reset") { [weak self] _ in
            self?.samples = []; self?.details = []; self?.events = []; self?.frame = 0
            return ["ok": true]
        }
    }

    private func video(_ query: [String: String]) -> ViewerVideo? {
        guard let list, let row = Int(query["row"] ?? ""), list.videos.indices.contains(row) else { return nil }
        return list.videos[row]
    }

    private func rows() -> [String: Any] {
        ["rows": (list?.videos ?? []).enumerated().map { index, video in
            ["row": index, "name": video.filename, "codec": video.videoCodec ?? "", "duration": video.duration,
             "size": video.size, "saved": list?.progress.time(video.progressKey) ?? 0,
             "width": video.displaySize?.width ?? 0, "height": video.displaySize?.height ?? 0] as [String: Any]
        }]
    }

    private func units(_ viewer: ViewerController) -> (all: [ViewerUnit], active: ViewerUnit?) {
        var all: [ViewerUnit] = [], active: ViewerUnit?
        for child in Mirror(reflecting: viewer).children {
            if child.label == "units", let value = child.value as? [ViewerUnit] { all = value }
            if child.label == "activeUnit", let value = child.value as? ViewerUnit { active = value }
        }
        return (all, active)
    }

    private func start() {
        guard link == nil else { return }
        previous = CACurrentMediaTime()
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    private func now() -> Double { ((CACurrentMediaTime() - origin) * 10_000).rounded() / 10 }

    private func mark(_ name: String, _ values: [String: Any] = [:]) {
        events.append(values.merging(["event": name, "at": now(), "sample": samples.count]) { _, new in new })
    }

    // One row per display frame: [ms, main-thread gap ms, active name, picture, playing, wants, clock, visible units, pictures shown].
    @objc private func tick() {
        let time = CACurrentMediaTime(), gap = (time - previous) * 1000
        previous = time
        frame += 1
        guard samples.count < 60_000 else { return }
        guard let viewer = list?.viewer else {
            samples.append([now(), (gap * 10).rounded() / 10, "", 0, 0, 0, -1.0, 0, 0])
            return
        }
        let (all, active) = units(viewer)
        let name = active?.video?.filename ?? ""
        samples.append([now(), (gap * 10).rounded() / 10, String(name.prefix(13)), active?.hasPicture == true ? 1 : active?.showsPoster == true ? 2 : 0,
                        active?.isPlaying == true ? 1 : 0, active?.wantsPlay == true ? 1 : 0,
                        ((active?.clockSeconds ?? -1) * 1000).rounded() / 1000,
                        all.filter { $0.video != nil && !$0.view.isHidden }.count, active?.frameSerial ?? 0])
        guard frame % 6 == 0, details.count < 8_000 else { return }
        let began = CACurrentMediaTime()
        let rows = all.compactMap { unit -> [String: Any]? in
            guard let video = unit.video else { return nil }
            var row = unit.playbackEvidence
            row["name"] = String(video.filename.prefix(13)); row["active"] = unit === active
            row["hidden"] = unit.view.isHidden; row["picture"] = unit.hasPicture; row["clock"] = unit.clockSeconds
            row["still"] = unit.showsPoster
            row.removeValue(forKey: "video"); row.removeValue(forKey: "stateEvents"); row.removeValue(forKey: "frameStepEvents")
            return row
        }
        // What this sampling itself cost the main thread, so its frames can be told apart.
        details.append(["at": now(), "sample": samples.count - 1, "units": rows, "costMs": ((CACurrentMediaTime() - began) * 10_000).rounded() / 10])
    }

    private func state() -> [String: Any] {
        guard let viewer = list?.viewer else { return ["viewer": false, "rows": list?.videos.count ?? 0, "samples": samples.count] }
        let (all, active) = units(viewer)
        return ["viewer": true, "rows": list?.videos.count ?? 0, "samples": samples.count, "at": now(),
                "current": viewer.currentVideo?.filename ?? "", "picture": active?.hasPicture ?? false, "still": active?.showsPoster ?? false,
                "playing": active?.isPlaying ?? false, "clock": active?.clockSeconds ?? -1,
                "units": all.filter { $0.video != nil }.count, "feed": viewer.zoomCheckState,
                "frames": DebugState.shared.snapshot()["frames"] ?? [:]]
    }
}
#endif
