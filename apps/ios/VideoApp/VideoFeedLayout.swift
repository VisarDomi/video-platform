import Foundation
import CoreGraphics

// One continuous document. Player reuse and selection never change these coordinates.
struct VideoFeedLayout {
    let frames: [CGRect]
    let size: CGSize

    init(viewport: CGSize, aspects: [CGSize]) {
        var y = viewport.height / 2
        frames = aspects.map { aspect in
            let valid = aspect.width.isFinite && aspect.height.isFinite && aspect.width > 0 && aspect.height > 0
            let aspect = valid ? aspect : CGSize(width: 16, height: 9)
            let scale = min(viewport.width / aspect.width, viewport.height / aspect.height)
            let size = CGSize(width: aspect.width * scale, height: aspect.height * scale)
            defer { y += size.height }
            return CGRect(x: (viewport.width - size.width) / 2, y: y, width: size.width, height: size.height)
        }
        size = CGSize(width: viewport.width, height: y + viewport.height / 2)
    }

    func index(at y: CGFloat) -> Int? {
        guard !frames.isEmpty else { return nil }
        var low = 0, high = frames.count - 1
        while low < high {
            let middle = (low + high + 1) / 2
            if frames[middle].minY <= y { low = middle } else { high = middle - 1 }
        }
        return low
    }
}
