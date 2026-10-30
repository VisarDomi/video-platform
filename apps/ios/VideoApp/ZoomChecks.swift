#if targetEnvironment(simulator)
import UIKit
import KitReader
import KitImages
import KitTestHooks

// A simulator-only calibration screen using the real viewer and strip reader. It creates
// no AVPlayerItem and touches no provider, login, saved library or audio session.
@MainActor
final class ZoomChecks: UIViewController, StripReaderDelegate {
    private let host = ZoomCheckHost()
    private var viewer: ViewerController?
    private var strip: StripReaderView?
    private var files: [URL] = []
    private var trace: [[String: Any]] = []
    private var link: CADisplayLink?
    private var started: CFTimeInterval = 0
    private var pinch: Task<Void, Never>?

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        TestHooks.shared.register("zoom-fixture") { [weak self] in self?.fixture($0) ?? [:] }
        TestHooks.shared.register("zoom-state") { [weak self] _ in self?.snapshot() ?? [:] }
        TestHooks.shared.register("zoom-scale") { [weak self] query in
            guard let self else { return [:] }
            let scale = CGFloat(Double(query["scale"] ?? "1") ?? 1)
            let animated = query["animated"] == "1"
            pinch?.cancel()
            let start = (snapshot()["scale"] as? CGFloat) ?? 1
            beginPinch()
            if animated {
                // UIKit's programmatic zoom omits the user-pinch start callback. Drive a
                // bounded sequence of real scroll-view scales between the gesture callbacks.
                pinch = Task { [weak self] in
                    for step in 1...18 {
                        try? await Task.sleep(for: .milliseconds(17))
                        guard !Task.isCancelled, let self else { return }
                        applyScale(start + (scale - start) * CGFloat(step) / 18)
                    }
                    self?.endPinch()
                }
            } else { applyScale(scale); endPinch() }
            return snapshot()
        }
        TestHooks.shared.register("zoom-metadata") { [weak self] _ in
            guard let self, let strip else { return [:] }
            strip.setAspect(0.18, at: 0)
            strip.append([StripPage(key: "appended", aspect: 0.2)])
            return snapshot()
        }
        TestHooks.shared.register("zoom-layout-check") { [weak self] _ in
            guard let self, let strip else { return [:] }
            let before = snapshot()
            let scroll = strip.scrollView
            scroll.delegate?.scrollViewWillBeginZooming?(scroll, with: strip.viewForZooming(in: scroll))
            strip.setAspect(0.18, at: 0)
            strip.append([StripPage(key: "appended", aspect: 0.2)])
            let during = snapshot()
            scroll.delegate?.scrollViewDidEndZooming?(scroll, with: strip.viewForZooming(in: scroll), atScale: scroll.zoomScale)
            return ["before": before, "during": during, "after": snapshot()]
        }
        TestHooks.shared.register("zoom-trace") { [weak self] query in
            guard let self else { return [:] }
            if query["start"] == "1" { startTrace() }
            return ["frames": trace]
        }
        TestHooks.shared.register("zoom-orientation") { [weak self] query in
            let mask: UIInterfaceOrientationMask = query["value"] == "landscape" ? .landscapeRight : .portrait
            self?.view.window?.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: mask))
            return ["requested": true]
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        viewer?.view.frame = view.bounds
        strip?.frame = view.bounds
    }

    private func fixture(_ query: [String: String]) -> [String: Any] {
        pinch?.cancel()
        link?.invalidate()
        if let viewer { viewer.willMove(toParent: nil); viewer.view.removeFromSuperview(); viewer.removeFromParent() }
        viewer = nil
        strip?.removeFromSuperview()
        strip = nil
        if query["kind"] == "reader" {
            let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("zoom-check", isDirectory: true)
            try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if files.isEmpty {
                let file = directory.appendingPathComponent("page.jpg")
                try! calibration(CGSize(width: 900, height: 4500)).jpegData(compressionQuality: 0.9)!.write(to: file)
                files = [file]
            }
            let reader = StripReaderView(pipeline: ImagePipeline(memoryLimit: 64 << 20, concurrency: 2))
            reader.delegate = self
            reader.frame = view.bounds
            view.addSubview(reader)
            reader.layoutIfNeeded()
            reader.setPages([StripPage(key: "page0", aspect: 0.2), StripPage(key: "page1", aspect: 0.2)],
                            position: StripPosition(index: 0, fraction: 0.45))
            reader.layoutIfNeeded()
            strip = reader
        } else {
            let size = CGSize(width: Double(query["width"] ?? "1920") ?? 1920, height: Double(query["height"] ?? "1080") ?? 1080)
            let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("zoom-check", isDirectory: true)
            let player = ViewerController(provider: "sc", host: host, media: ViewerMedia(),
                                          progress: ProgressStore(directory: directory), checkpoint: CheckpointWriter(directory: directory))
            addChild(player)
            player.view.frame = view.bounds
            view.addSubview(player.view)
            player.didMove(toParent: self)
            player.configureZoomCheck(size: size, image: calibration(CGSize(width: 320, height: min(2048, 320 * size.height / max(1, size.width)))))
            viewer = player
        }
        return snapshot()
    }

    private func beginPinch() {
        if let viewer { viewer.beginZoomCheck() }
        else if let strip { strip.scrollView.delegate?.scrollViewWillBeginZooming?(strip.scrollView, with: strip.viewForZooming(in: strip.scrollView)) }
    }

    private func applyScale(_ scale: CGFloat) {
        if let viewer { viewer.setZoomCheckScale(scale, animated: false) }
        else { strip?.scrollView.setZoomScale(scale, animated: false) }
    }

    private func endPinch() {
        if let viewer { viewer.endZoomCheck() }
        else if let strip { strip.scrollViewDidEndZooming(strip.scrollView, with: strip.viewForZooming(in: strip.scrollView), atScale: strip.scrollView.zoomScale) }
    }

    private func calibration(_ size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.systemTeal.setFill(); context.fill(CGRect(origin: .zero, size: size))
            context.cgContext.setStrokeColor(UIColor.white.cgColor)
            context.cgContext.setLineWidth(3)
            for x in stride(from: CGFloat(0), through: size.width, by: size.width / 8) {
                context.cgContext.move(to: CGPoint(x: x, y: 0)); context.cgContext.addLine(to: CGPoint(x: x, y: size.height))
            }
            for y in stride(from: CGFloat(0), through: size.height, by: size.width / 8) {
                context.cgContext.move(to: CGPoint(x: 0, y: y)); context.cgContext.addLine(to: CGPoint(x: size.width, y: y))
            }
            context.cgContext.strokePath()
            UIColor.systemPink.setStroke(); context.cgContext.setLineWidth(12)
            context.cgContext.stroke(CGRect(origin: .zero, size: size).insetBy(dx: 6, dy: 6))
        }
    }

    private func snapshot() -> [String: Any] {
        if let viewer { return viewer.zoomCheckState.merging(["kind": "video"]) { a, _ in a } }
        guard let strip, let content = strip.viewForZooming(in: strip.scrollView) else { return [:] }
        var images: [String] = []
        func visit(_ node: UIView) {
            if let image = node as? UIImageView, image.image != nil, !image.isHidden { images.append(String(describing: ObjectIdentifier(image))) }
            node.subviews.forEach(visit)
        }
        visit(content)
        return ["kind": "reader", "scale": strip.scrollView.zoomScale, "contentHeight": content.bounds.height,
                "pages": strip.pages.count, "images": images, "state": strip.state]
    }

    private func startTrace() {
        link?.invalidate(); trace = []; started = CACurrentMediaTime()
        let display = CADisplayLink(target: self, selector: #selector(sample))
        display.add(to: .main, forMode: .common); link = display
    }

    @objc private func sample() {
        trace.append(snapshot().merging(["at": CACurrentMediaTime() - started]) { a, _ in a })
        if trace.count >= 120 { link?.invalidate(); link = nil }
    }

    func strip(_ strip: StripReaderView, sourceFor index: Int) -> ImageSource { .file(files[0]) }
    func strip(_ strip: StripReaderView, settledAt position: StripPosition) {}
}

@MainActor
private final class ZoomCheckHost: ViewerHost {
    func resolve(_ video: ViewerVideo) async throws -> MediaSource { throw URLError(.unsupportedURL) }
    func related(_ video: ViewerVideo) async throws -> [ViewerVideo] { [] }
    func follow(_ video: ViewerVideo, _ follow: Bool) async throws {}
    func block(_ video: ViewerVideo) async throws {}
    func remove(_ filename: String) {}
    func append(_ videos: [ViewerVideo]) {}
    func highlight(_ filename: String, reveal: Bool) {}
    func changed(_ video: ViewerVideo) {}
    func login() {}
}
#endif
