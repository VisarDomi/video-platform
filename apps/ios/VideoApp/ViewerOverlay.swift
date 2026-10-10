import UIKit

// The web viewer's fixed overlay (packages/app src/player/OverlayView.ts and buttons.css): the
// name, the time, the 100 pt progress bar with the cut markers, and the button row. It follows
// the current video; only its controls take touches; its controls are disabled while a swipe
// settles. Live streams show no timeline.
@MainActor
protocol ViewerOverlayActions: AnyObject {
    func overlaySeek(_ time: Double, resume: Bool)
    func overlayToggleMuteOrUndo()
    func overlayReturnOriginal()
    func overlaySaveOrCut(_ playbackDuration: Double)
    func overlayAddMarker()
    func overlayToggleFollow()
    func overlayBlock()
}

@MainActor
final class ViewerOverlay: UIView {
    weak var actions: ViewerOverlayActions?
    private let name = UILabel()
    private let time = PaddedLabel(insets: UIEdgeInsets(top: 4, left: 12, bottom: 4, right: 12))
    private let segmentName = PaddedLabel(insets: UIEdgeInsets(top: 4, left: 12, bottom: 4, right: 12))
    private let progress = UIView()
    private let fill = UIView()
    private let markerLayer = UIView()
    private let segmentText = UIStackView()
    private let muteUndo = OverlayButton()
    private let follow = OverlayButton()
    private let membershipButton = OverlayButton()
    private var choices: [OverlayButton] = []
    private let block = OverlayButton()
    private let returnOriginal = OverlayButton()
    private let saveCut = OverlayButton()
    private let addMarker = OverlayButton()
    private var blockConfirm = false

    private(set) var video: ViewerVideo?
    private var timeline = TimelineSnapshot()
    private var segments: [Double] = []
    private var muted = true
    private var uiVisible = true
    private var interactive = true
    private var scrubbing = false

    // The download-list button (DownloadListButton.ts): ⏳ checking or changing, ➕/➖, ⚠️ unreadable,
    // a yellow ring after a failed change (keeping the last confirmed state), one button per list
    // while choosing, 🔍 when no provider has the streamer.
    private enum ListState {
        case none, loading, ready(Bool), choosing(confirmed: Bool, targets: [String]), notFound
        case adding, removing, unavailable(String), error(confirmed: Bool, String)
    }
    private var listState = ListState.none
    private var membership: Membership?
    private var listToken = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        name.font = .boldSystemFont(ofSize: 19)
        name.textColor = .white
        name.numberOfLines = 0
        name.lineBreakMode = .byCharWrapping
        shadow(name.layer, radius: 2)
        let mono = UIFont(name: "CourierNewPS-BoldMT", size: 18) ?? .monospacedSystemFont(ofSize: 18, weight: .bold)
        time.font = mono
        time.textColor = UIColor(white: 0.94, alpha: 1)
        segmentName.font = mono.withSize(9)
        segmentName.textColor = UIColor(red: 1, green: 0.82, blue: 0.4, alpha: 1)
        for label in [time, segmentName] {
            label.backgroundColor = UIColor(white: 0, alpha: 0.5)
            label.layer.cornerRadius = 6
            label.clipsToBounds = true
            shadow(label.layer, radius: 2)
        }
        progress.backgroundColor = UIColor(white: 1, alpha: 0.3)
        progress.layer.cornerRadius = 10
        progress.clipsToBounds = true
        fill.backgroundColor = UIColor(red: 1, green: 0.37, blue: 0.23, alpha: 1)
        fill.layer.cornerRadius = 10
        segmentText.axis = .vertical
        segmentText.isUserInteractionEnabled = false
        markerLayer.isUserInteractionEnabled = false
        progress.addSubview(fill)
        progress.addSubview(markerLayer)
        progress.addSubview(segmentText)
        let scrub = UILongPressGestureRecognizer(target: self, action: #selector(scrubbed(_:)))
        scrub.minimumPressDuration = 0
        scrub.allowableMovement = .greatestFiniteMagnitude
        progress.addGestureRecognizer(scrub)
        for view in [name, time, segmentName, progress] as [UIView] { addSubview(view) }
        for button in [muteUndo, follow, membershipButton, block, returnOriginal, saveCut, addMarker] { addSubview(button) }
        muteUndo.addAction(UIAction { [weak self] _ in self?.actions?.overlayToggleMuteOrUndo() }, for: .touchUpInside)
        returnOriginal.addAction(UIAction { [weak self] _ in self?.actions?.overlayReturnOriginal() }, for: .touchUpInside)
        saveCut.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.actions?.overlaySaveOrCut(self.effectiveDuration())
        }, for: .touchUpInside)
        addMarker.addAction(UIAction { [weak self] _ in self?.actions?.overlayAddMarker() }, for: .touchUpInside)
        follow.addAction(UIAction { [weak self] _ in self?.actions?.overlayToggleFollow() }, for: .touchUpInside)
        // Blocking asks once more, as in Stream Viewer.
        block.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            if !self.blockConfirm { self.blockConfirm = true; self.renderButtons(); return }
            self.blockConfirm = false
            self.actions?.overlayBlock()
        }, for: .touchUpInside)
        membershipButton.addAction(UIAction { [weak self] _ in self?.toggleMembership() }, for: .touchUpInside)
        returnOriginal.setTitle("🔄", for: .normal)
        addMarker.setTitle("📍", for: .normal)
        render()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    // Only the controls paint and take touches; everything else reaches the videos beneath.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let hit = super.hitTest(point, with: event)
        return hit === self || hit === name || hit === time || hit === segmentName ? nil : hit
    }

    func setVideo(_ video: ViewerVideo?) {
        if video?.filename != self.video?.filename { blockConfirm = false }
        self.video = video
        render()
    }

    func setTimeline(_ timeline: TimelineSnapshot) {
        self.timeline = timeline
        renderTimeline()
        renderButtons()
    }

    func setMuted(_ muted: Bool) {
        self.muted = muted
        renderButtons()
    }

    func setUiVisible(_ visible: Bool) {
        uiVisible = visible
        renderVisibility()
    }

    func setInteractive(_ interactive: Bool) {
        self.interactive = interactive
        renderButtons()
    }

    func setSegments(_ segments: [Double]) {
        self.segments = segments
        renderTimeline()
        renderButtons()
    }

    // The video's streamer in the download lists; nil hides the button. A newer call replaces this one.
    func showMembership(_ info: MembershipInfo?) {
        listToken += 1
        let token = listToken
        membership = nil
        setList(.none)
        guard let info else { return }
        let candidate = Membership(info)
        setList(.loading)
        Task {
            do {
                let member = try await candidate.isMember()
                guard token == listToken else { return }
                membership = candidate
                setList(.ready(member))
            } catch {
                guard token == listToken else { return }
                setList(.unavailable(error.localizedDescription))
            }
        }
    }

    private func toggleMembership() {
        guard let membership else { return }
        let confirmed: Bool
        switch listState {
        case .ready(let member): confirmed = member
        case .error(let member, _): confirmed = member
        default: return
        }
        guard membership.info.choose else { return change(add: !confirmed, target: nil) }
        listToken += 1
        let token = listToken
        setList(confirmed ? .removing : .adding)
        Task {
            do {
                let targets = try await membership.targets(add: !confirmed) ?? []
                guard token == listToken else { return }
                if targets.count == 1 { return change(add: !confirmed, target: targets[0]) }
                setList(targets.isEmpty ? .notFound : .choosing(confirmed: confirmed, targets: targets))
            } catch {
                guard token == listToken else { return }
                setList(.unavailable(error.localizedDescription))
            }
        }
    }

    // Membership is asked again to confirm a change.
    private func change(add: Bool, target: String?) {
        guard let membership else { return }
        listToken += 1
        let token = listToken
        setList(add ? .adding : .removing)
        Task {
            do {
                try await membership.change(add: add, target: target)
                let member = try await membership.isMember()
                guard token == listToken else { return }
                setList(.ready(member))
            } catch {
                guard token == listToken else { return }
                setList(.error(confirmed: !add, error.localizedDescription))
            }
        }
    }

    private func setList(_ state: ListState) {
        listState = state
        renderMembership()
        setNeedsLayout()
    }

    private func renderMembership() {
        var member: Bool?
        var hidden = false, error = false
        var title = "⏳"
        switch listState {
        case .none: hidden = true
        case .choosing: hidden = true
        case .ready(let value): member = value
        case .error(let value, _): member = value; error = true
        case .unavailable: title = "⚠️"; error = true
        case .notFound: title = "🔍"
        case .loading, .adding, .removing: break
        }
        if let member { title = member ? "➖" : "➕" }
        membershipButton.setTitle(title, for: .normal)
        membershipButton.isHidden = hidden
        membershipButton.isEnabled = interactive && member != nil
        membershipButton.accent = error ? nil : member.map { $0 ? .remove : .add }
        membershipButton.ring = error
        choices.forEach { $0.removeFromSuperview() }
        choices = []
        if case .choosing(let confirmed, let targets) = listState {
            choices = targets.map { target in
                let choice = OverlayButton(small: true)
                choice.setTitle(target, for: .normal)
                choice.accent = confirmed ? .remove : .add
                choice.isEnabled = interactive
                choice.addAction(UIAction { [weak self] _ in self?.change(add: !confirmed, target: target) }, for: .touchUpInside)
                addSubview(choice)
                return choice
            }
        }
    }

    private func render() {
        name.text = video?.name ?? ""
        renderVisibility()
        renderTimeline()
        renderButtons()
    }

    private func renderVisibility() {
        isHidden = !(uiVisible && video != nil)
        let live = video?.liveStream ?? false
        time.isHidden = live
        segmentName.isHidden = live || timeline.currentSegmentName == nil
        progress.isHidden = live
        setNeedsLayout()
    }

    private func renderTimeline() {
        let duration = effectiveDuration()
        let fraction = duration > 0 ? timeline.currentTime / duration : 0
        time.text = "\(Self.format(timeline.currentTime)) / \(Self.format(duration))"
        segmentName.text = timeline.currentSegmentName
        segmentName.isHidden = video?.liveStream == true || timeline.currentSegmentName == nil
        fill.frame = CGRect(x: 0, y: 0, width: progress.bounds.width * max(0, min(1, fraction)), height: progress.bounds.height)
        markerLayer.subviews.forEach { $0.removeFromSuperview() }
        segmentText.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard duration > 0 else { setNeedsLayout(); return }
        for point in segments {
            let marker = UIView()
            marker.backgroundColor = .white
            marker.frame = CGRect(x: progress.bounds.width * point / duration - 2, y: 0, width: 4, height: progress.bounds.height)
            markerLayer.addSubview(marker)
        }
        for index in stride(from: 0, to: segments.count, by: 2) {
            let row = UIStackView()
            row.distribution = .equalSpacing
            row.addArrangedSubview(segmentLabel("start: \(Self.format(segments[index]))"))
            if index + 1 < segments.count { row.addArrangedSubview(segmentLabel("end: \(Self.format(segments[index + 1]))")) }
            segmentText.addArrangedSubview(row)
        }
        setNeedsLayout()
    }

    private func segmentLabel(_ text: String) -> UILabel {
        let label = UILabel()
        label.text = text
        label.textColor = .white
        label.font = UIFont(name: "CourierNewPS-BoldMT", size: 16) ?? .monospacedSystemFont(ofSize: 16, weight: .bold)
        shadow(label.layer, radius: 4)
        return label
    }

    private func renderButtons() {
        let local = video?.local ?? false
        let live = video?.liveStream ?? false
        follow.isHidden = !live
        block.isHidden = !live
        follow.setTitle(video?.following == true ? "❤️" : "🤍", for: .normal)
        block.setTitle(blockConfirm ? "❓" : "🚫", for: .normal)
        let isOriginal = local && video?.edited == false && !timeline.isLive
        let isEdited = local && video?.edited == true
        let hasSegments = isOriginal && !segments.isEmpty
        muteUndo.setTitle(hasSegments ? "↪️" : muted ? "🔇" : "🔊", for: .normal)
        returnOriginal.isHidden = !isEdited
        saveCut.isHidden = !isOriginal
        addMarker.isHidden = !isOriginal
        saveCut.setTitle(hasSegments ? "✂️" : "✅", for: .normal)
        for control in [muteUndo, follow, block, returnOriginal, addMarker] { control.isEnabled = interactive }
        saveCut.isEnabled = interactive && !(hasSegments && segments.count % 2 != 0)
        renderMembership()
        setNeedsLayout()
    }

    private func effectiveDuration() -> Double {
        let value = timeline.duration == .infinity && (timeline.seekableEnd ?? 0) > 0 ? timeline.seekableEnd! : timeline.duration
        return value.isFinite && value > 0 ? value : 0
    }

    // The bar seeks where it is touched and scrubs while the finger moves.
    @objc private func scrubbed(_ recognizer: UILongPressGestureRecognizer) {
        guard interactive || scrubbing else { return }
        let x = recognizer.location(in: progress).x
        let duration = effectiveDuration()
        let target = duration > 0 ? duration * max(0, min(1, x / max(1, progress.bounds.width))) : 0
        switch recognizer.state {
        case .began: scrubbing = true; actions?.overlaySeek(target, resume: true)
        case .changed: actions?.overlaySeek(target, resume: false)
        case .ended: scrubbing = false; actions?.overlaySeek(target, resume: true)
        default: scrubbing = false
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let safe = safeAreaInsets
        let left = max(15, safe.left), right = max(15, safe.right)
        let width = bounds.width - left - right
        var y = safe.top + 15
        let nameSize = name.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        name.frame = CGRect(x: left, y: y, width: width, height: nameSize.height)
        y += nameSize.height + 10
        if !time.isHidden {
            let timeSize = time.intrinsicContentSize
            let segmentSize = segmentName.isHidden ? .zero : segmentName.intrinsicContentSize
            let total = timeSize.width + (segmentName.isHidden ? 0 : 8 + segmentSize.width)
            var x = left + (width - total) / 2
            time.frame = CGRect(x: x, y: y, width: timeSize.width, height: timeSize.height)
            x += timeSize.width + 8
            segmentName.frame = CGRect(x: x, y: y + (timeSize.height - segmentSize.height) / 2, width: segmentSize.width, height: segmentSize.height)
            y += timeSize.height + 8
        }
        if !progress.isHidden {
            let resized = progress.frame.size != CGSize(width: width, height: 100)
            progress.frame = CGRect(x: left, y: y, width: width, height: 100)
            markerLayer.frame = progress.bounds
            segmentText.frame = progress.bounds.inset(by: UIEdgeInsets(top: 8, left: 15, bottom: 8, right: 15))
            segmentText.frame.size.height = segmentText.systemLayoutSizeFitting(segmentText.frame.size).height
            if resized { renderTimeline() }
            y += 110
        }
        var x = left
        for button in [muteUndo, follow, membershipButton] + choices + [block, returnOriginal, saveCut, addMarker] where !button.isHidden {
            let size = button.intrinsicContentSize
            button.frame = CGRect(x: x, y: y, width: size.width, height: size.height)
            x += size.width + 10
        }
    }

    static func format(_ seconds: Double) -> String {
        guard seconds.isFinite else { return "00:00.000" }
        let total = Int(seconds)
        let milliseconds = Int((seconds - floor(seconds)) * 1000)
        let clock = String(format: "%02d:%02d.%03d", (total % 3600) / 60, total % 60, milliseconds)
        return total >= 3600 ? String(format: "%02d:", total / 3600) + clock : clock
    }
}

private func shadow(_ layer: CALayer, radius: CGFloat) {
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 1
    layer.shadowRadius = radius / 2
    layer.shadowOffset = CGSize(width: 1, height: 1)
    layer.masksToBounds = false
}

final class PaddedLabel: UILabel {
    private let insets: UIEdgeInsets
    init(insets: UIEdgeInsets) {
        self.insets = insets
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: insets)) }
    override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + insets.left + insets.right, height: size.height + insets.top + insets.bottom)
    }
}

// buttons.css: a white-bordered, translucent black button with a 36 pt emoji; green or red
// border for the list's add or remove, a yellow ring after a failed list change.
final class OverlayButton: UIButton {
    enum Accent { case add, remove }
    var accent: Accent? { didSet { style() } }
    var ring = false { didSet { style() } }
    private let small: Bool

    init(small: Bool = false) {
        self.small = small
        super.init(frame: .zero)
        titleLabel?.font = .systemFont(ofSize: small ? 22 : 36)
        setTitleColor(.white, for: .normal)
        setTitleColor(UIColor(white: 0.53, alpha: 1), for: .disabled)
        backgroundColor = UIColor(white: 0, alpha: 0.6)
        layer.cornerRadius = 8
        layer.borderWidth = 1
        style()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override var isEnabled: Bool { didSet { style() } }

    override var intrinsicContentSize: CGSize {
        let label = titleLabel?.intrinsicContentSize ?? .zero
        return CGSize(width: max(small ? 0 : 70, label.width + 36 + 2), height: label.height + 24 + 2)
    }

    private func style() {
        alpha = isEnabled ? 1 : 0.6
        let color: UIColor = !isEnabled ? UIColor(white: 0.53, alpha: 1)
            : accent == .add ? UIColor(red: 0.2, green: 0.78, blue: 0.35, alpha: 1)
            : accent == .remove ? UIColor(red: 1, green: 0.37, blue: 0.23, alpha: 1) : .white
        layer.borderColor = color.cgColor
        layer.shadowColor = UIColor(red: 1, green: 0.82, blue: 0.4, alpha: 1).cgColor
        layer.shadowOpacity = ring ? 1 : 0
        layer.shadowRadius = 0
        layer.shadowOffset = .zero
        layer.shadowPath = ring ? UIBezierPath(roundedRect: bounds.insetBy(dx: -2, dy: -2), cornerRadius: 10).cgPath : nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if ring { style() }
    }
}
