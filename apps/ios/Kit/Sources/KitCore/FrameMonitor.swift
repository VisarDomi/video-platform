#if canImport(UIKit)
import QuartzCore
import UIKit

// Where scrolling loses frames, measured on the phone (Instruments cannot record it here): while
// anything scrolls, every frame that takes longer than `hitch` is kept with the spans of our own
// code that ran in it (measure) and what was handed to the screen in it (note: an image's size).
// A long frame with no span of ours is the system's (Core Animation's commit or the render
// server, often a large image). Read through DebugState ("frames"), which the apps write when
// they leave the screen.
@MainActor
public final class FrameMonitor {
    public static let shared = FrameMonitor()

    public struct Hitch {
        let at: Double
        let frame: Double
        let spans: [String: Double]
        let notes: [String]
    }

    private struct Total { var count = 0; var total = 0.0; var max = 0.0 }

    public var hitch: Double = 0.025
    private var link: CADisplayLink?
    private var scrollers = 0
    private var stopScheduled = false
    private var last: CFTimeInterval = 0
    private var started = CACurrentMediaTime()
    private var frameSpans: [String: Double] = [:]
    private var frameNotes: [String] = []
    private var totals: [String: Total] = [:]
    private var hitches: [Hitch] = []
    private var frames = 0
    private var slow = 0
    private var verySlow = 0
    private var worst = 0.0

    private init() {
        DebugState.shared.register("frames") { [weak self] in self?.state ?? [:] }
    }

    // Our own work on the main thread, by name (counted always; tied to a frame while scrolling).
    public func measure<T>(_ label: String, _ work: () throws -> T) rethrows -> T {
        let start = CACurrentMediaTime()
        defer {
            let elapsed = CACurrentMediaTime() - start
            var total = totals[label] ?? Total()
            total.count += 1
            total.total += elapsed
            total.max = max(total.max, elapsed)
            totals[label] = total
            if link != nil { frameSpans[label, default: 0] += elapsed }
        }
        return try work()
    }

    public func note(_ text: String) {
        guard link != nil, frameNotes.count < 8 else { return }
        frameNotes.append(text)
    }

    // A scroll view started or stopped moving (finger or momentum); frames are watched while
    // any moves, and half a second after.
    public func scrolling(_ moving: Bool) {
        if moving {
            scrollers += 1
            guard link == nil else { return }
            let link = CADisplayLink(target: Target { [weak self] link in self?.tick(link) }, selector: #selector(Target.fire(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
            last = 0
        } else {
            scrollers = max(0, scrollers - 1)
            guard scrollers == 0, !stopScheduled else { return }
            stopScheduled = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self else { return }
                stopScheduled = false
                guard scrollers == 0 else { return }
                link?.invalidate()
                link = nil
                frameSpans = [:]
                frameNotes = []
            }
        }
    }

    private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        defer {
            last = now
            frameSpans = [:]
            frameNotes = []
        }
        guard last > 0 else { return }
        let frame = now - last
        frames += 1
        worst = max(worst, frame)
        guard frame > hitch else { return }
        slow += 1
        if frame > 0.05 { verySlow += 1 }
        hitches.append(Hitch(at: now - started, frame: frame, spans: frameSpans, notes: frameNotes))
        if hitches.count > 40 { hitches.removeFirst() }
    }

    private var state: [String: Any] {
        let ms = { (seconds: Double) in (seconds * 10_000).rounded() / 10 }
        return [
            "frames": frames, "hitches": slow, "over50ms": verySlow, "worstMs": ms(worst),
            "spans": totals.mapValues { ["count": $0.count, "totalMs": ms($0.total), "maxMs": ms($0.max)] },
            "recent": hitches.map { hitch in
                ["atS": (hitch.at * 10).rounded() / 10, "frameMs": ms(hitch.frame), "spans": hitch.spans.mapValues(ms), "notes": hitch.notes] as [String: Any]
            },
        ]
    }
}

private final class Target: NSObject {
    let action: (CADisplayLink) -> Void
    init(_ action: @escaping (CADisplayLink) -> Void) { self.action = action }
    @objc func fire(_ link: CADisplayLink) { action(link) }
}
#endif
