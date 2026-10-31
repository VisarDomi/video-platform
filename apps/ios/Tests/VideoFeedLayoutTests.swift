import Foundation
import CoreGraphics

@main struct VideoFeedLayoutTests {
    static func main() {
        for viewport in [CGSize(width: 428, height: 926), CGSize(width: 926, height: 428)] {
            let sizes = [CGSize(width: 16, height: 9), CGSize(width: 9, height: 16), CGSize(width: 9, height: 32), CGSize(width: 1, height: 1)]
            let layout = VideoFeedLayout(viewport: viewport, aspects: Array(repeating: sizes, count: 1000).flatMap { $0 })
            precondition(layout.frames.count == 4000)
            for (index, frame) in layout.frames.enumerated() {
                let aspect = sizes[index % sizes.count]
                precondition(frame.width <= viewport.width + 0.001 && frame.height <= viewport.height + 0.001)
                precondition(abs(frame.width / frame.height - aspect.width / aspect.height) < 0.0001)
                precondition(layout.index(at: frame.midY) == index)
                if index > 0 { precondition(abs(layout.frames[index - 1].maxY - frame.minY) < 0.001) }
            }
            // Natural document coordinates allow a fling to cross many items directly.
            precondition(layout.index(at: layout.frames[3701].midY) == 3701)
            precondition(layout.index(at: -10) == 0)
            precondition(layout.index(at: layout.size.height + 10) == 3999)
        }
        precondition(VideoFeedLayout(viewport: CGSize(width: 428, height: 926), aspects: []).index(at: 0) == nil)
        print("PASS: 8,000 fitted continuous frames, both orientations, no gaps/runways, arbitrary multi-item traversal and boundaries")
    }
}
