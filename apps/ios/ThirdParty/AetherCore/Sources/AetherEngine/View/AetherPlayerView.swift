import Foundation
import QuartzCore
import AVFoundation

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A single render surface owned by AetherEngine.
///
/// The host embeds one instance (UIKit on iOS/tvOS, AppKit on macOS) and
/// hands it to `engine.bind(view:)`. The engine then attaches whichever
/// `CALayer` is active for the current source:
///
/// - `AVPlayerLayer` for the native AVPlayer path (HEVC, H.264, plus AV1
///   on devices with hardware AV1 decode).
/// - `AVSampleBufferDisplayLayer` for the software path driven by
///   `SoftwarePlaybackHost` (AV1 without hardware decode, VP9, MPEG-4
///   Part 2, MPEG-2, VC-1).
///
/// The view swaps the hosted layer internally on dispatch changes, so the
/// host never needs to know which backend is rendering. The active layer
/// can also change across sessions when consecutive sources dispatch to
/// different paths.
@MainActor
public final class AetherPlayerView: PlatformBaseView, HeldStillSurface {

    private var hostedLayer: CALayer?
    /// AE#711 follow-up: the picture held over an in-place item swap, above `hostedLayer`.
    private let presenter = HeldStillPresenter()
    private var stillLayer: CALayer? { presenter.layer ?? presenter.playerLayer }

    /// Engine-internal. The engine this view was last bound to, so a dismantling surface can unbind
    /// from it synchronously and a second engine binding the view can take it over (AE#536).
    weak var bindingEngine: AetherEngine?

    #if canImport(UIKit)
    public override init(frame: CGRect) {
        super.init(frame: frame)
        commonInit()
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }
    #elseif canImport(AppKit)
    public override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        commonInit()
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }
    #endif

    private func commonInit() {
        #if canImport(UIKit)
        backgroundColor = .black
        #elseif canImport(AppKit)
        wantsLayer = true
        layer?.backgroundColor = CGColor.black
        #endif
    }

    // MARK: - Layout

    #if canImport(UIKit)
    public override func layoutSubviews() {
        super.layoutSubviews()
        applyLayerFrame()
    }
    #elseif canImport(AppKit)
    public override func layout() {
        super.layout()
        applyLayerFrame()
    }
    #endif

    private func applyLayerFrame() {
        guard hostedLayer != nil || stillLayer != nil else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        hostedLayer?.frame = bounds
        presenter.layout(bounds)
        CATransaction.commit()
    }

    // MARK: - Engine-only attachment

    /// Engine-internal. Replace whichever layer is currently hosted with
    /// `layer`. Synchronous, runs on the main actor, no implicit
    /// animations so swaps don't flash. Idempotent if the same layer is
    /// already attached. A previously hosted layer is removed only while it
    /// still sits in this view: a layer an engine has since presented on
    /// another surface is not pulled back out of it (AE#536).
    func attach(_ layer: CALayer) {
        if hostedLayer === layer { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if let hosted = hostedLayer, hosted.superlayer === self.layer {
            hosted.removeFromSuperlayer()
        }
        #if canImport(UIKit)
        if let still = stillLayer { self.layer.insertSublayer(layer, below: still) } else { self.layer.addSublayer(layer) }
        #elseif canImport(AppKit)
        if let still = stillLayer { self.layer?.insertSublayer(layer, below: still) } else { self.layer?.addSublayer(layer) }
        // Resize the video layer in lockstep with the view's bounds during a
        // live window drag. Without this it only catches up on the next layout()
        // pass, and because an NSView's layer is anchored bottom-left that lag
        // reads as the image sliding off-center while resizing. Starting at full
        // bounds with both axes flexible keeps it full-bounds throughout.
        layer.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
        #endif
        layer.frame = bounds
        hostedLayer = layer
        CATransaction.commit()
    }

    /// Engine-internal. Remove the current hosted layer without
    /// replacement (used on unbind / teardown). Same ownership rule as
    /// `attach`: a layer that has moved to another surface stays there.
    func detach() {
        clearStill()
        guard let hosted = hostedLayer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if hosted.superlayer === self.layer {
            hosted.removeFromSuperlayer()
        }
        hostedLayer = nil
        CATransaction.commit()
    }

    // MARK: - Held picture

    /// Engine-internal. Lays `frame` over the hosted layer until `clearStill()`, see `HeldStillPresenter`.
    @discardableResult
    func showStill(_ frame: CVPixelBuffer, gravity: AVLayerVideoGravity, isHDR: Bool) -> Bool {
        let host: CALayer? = layer
        return presenter.show(frame, gravity: gravity, isHDR: isHDR, on: host, bounds: bounds)
    }

    func showCompositorStill(file: URL, pastFirstFrameBy offset: Double, gravity: AVLayerVideoGravity,
                             budgetSeconds: Double) async -> Bool {
        let host: CALayer? = layer
        return await presenter.show(file: file, pastFirstFrameBy: offset, gravity: gravity,
                                    on: host, bounds: bounds, budgetSeconds: budgetSeconds)
    }

    /// Engine-internal. Removes the held picture, if any. Idempotent.
    func clearStill() { presenter.clear() }

    var isHoldingStill: Bool { presenter.isShowing }
}

// MARK: - Platform base view alias

#if canImport(UIKit)
public typealias PlatformBaseView = UIView
#elseif canImport(AppKit)
public typealias PlatformBaseView = NSView
#endif
