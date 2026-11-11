import Foundation

/// Where the inline host (Bunkr's original files) lands a seek or a saved start position.
///
/// An exact landing decodes every picture from the keyframe before the target up to it. The
/// library's 4K60 files keep their keyframes 4 to 7 s apart, so that is up to 420 pictures for
/// one seek, repeated for every touch sample of a drag, every saved position and every paused
/// neighbour. A keyframe costs one picture, on any decoder.
///
/// Local addition (not upstream): the upstream rule (`SWKeyframeSnap`) covers dav1d only and
/// measures from the moving playhead, which sends a slow drag back and forth between keyframes.
enum InlineKeyframeLanding {
    /// Process switch, set once by the host before its first load.
    nonisolated(unsafe) static var enabled = false

    enum Landing: Equatable {
        /// Reposition onto this keyframe (source seconds, a value taken from `keyframes`).
        case keyframe(Double)
        /// No keyframe serves this seek; decode up to the target.
        case exact
        /// The picture already showing is the nearest one this decoder can give; do not seek.
        case stay
    }

    /// A request this close to the origin asks for the picture already showing: a drag's first
    /// touch sample carries no movement yet.
    static let stillSeconds = 0.25

    /// - Parameters:
    ///   - target: where the seek asks to be, source seconds.
    ///   - origin: where the gesture began (the playhead for a single jump). A landing never
    ///     crosses it: a forward seek shows nothing earlier, a backward seek nothing later.
    ///   - keyframes: ascending source seconds.
    ///   - indexComplete: false while a Matroska file has only the keyframes read so far.
    ///   - decodesFast: a hardware decoder, for which a short exact landing is affordable.
    static func landing(target: Double, origin: Double, keyframes: [Double],
                        indexComplete: Bool, decodesFast: Bool) -> Landing {
        guard target.isFinite, origin.isFinite else { return .exact }
        guard abs(target - origin) >= stillSeconds else { return .stay }
        guard let first = keyframes.first, let last = keyframes.last else { return .exact }
        // An index that ends before the target says nothing about the keyframes around it.
        guard indexComplete || last >= target else { return .exact }
        // The last keyframe at or before a position, and the first one after it.
        func around(_ seconds: Double) -> (before: Double?, after: Double?) {
            var low = 0, high = keyframes.count
            while low < high {
                let middle = (low + high) / 2
                if keyframes[middle] <= seconds { low = middle + 1 } else { high = middle }
            }
            return (low > 0 ? keyframes[low - 1] : nil, low < keyframes.count ? keyframes[low] : nil)
        }
        let (before, after) = around(target)
        if target > origin {
            if let before, before > origin { return .keyframe(before) }
            // The target shares its group of pictures with the origin.
            if decodesFast { return .exact }
            // A software decoder reaches it no sooner than playing on would: jump to the next
            // keyframe once the target is nearer to it than to the origin, and wait until then.
            if let after, after - target <= target - origin { return .keyframe(after) }
            return .stay
        }
        guard let before else { return .keyframe(first) }
        // An earlier group of pictures than the origin's: its keyframe is the picture.
        if around(origin).before != before { return .keyframe(before) }
        if decodesFast { return .exact }
        return target - before <= origin - target ? .keyframe(before) : .stay
    }

    /// The keyframe a saved position starts from: the last one at or before it.
    static func start(target: Double, keyframes: [Double]) -> Double? {
        guard target.isFinite else { return nil }
        return keyframes.last { $0 <= target }
    }
}
