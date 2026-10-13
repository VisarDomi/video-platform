#if canImport(UIKit)
import UIKit
import KitCore
import KitImages

@MainActor
public protocol ThumbnailStripDelegate: AnyObject {
    func strip(_ strip: ThumbnailStripView, sourceFor index: Int) -> ImageSource
    func strip(_ strip: ThumbnailStripView, didSelect index: Int)
    // The strip's own scroll settled (save its offset).
    func stripDidSettle(_ strip: ThumbnailStripView)
    // The thumbnail's file when it is already on the phone (a relaunch shows it in its first
    // frame: ImagePipeline.beginRestore).
    func strip(_ strip: ThumbnailStripView, localFileFor index: Int) -> URL?
    func stripDidScroll(_ strip: ThumbnailStripView)
}

public extension ThumbnailStripDelegate {
    func strip(_ strip: ThumbnailStripView, localFileFor index: Int) -> URL? { nil }
    // The strip is being swiped (its thumbnails can be fetched ahead of everything else).
    func stripDidScroll(_ strip: ThumbnailStripView) {}
}

// A row of fixed-size thumbnails scrolled sideways (the gallery apps' strips: 100×300
// covers, no gaps, no scroll bar). Thumbnails decode near the screen, the closest first,
// distance counted on screen, so both the list's and the strip's own scroll count.
@MainActor
public final class ThumbnailStripView: UIView, UICollectionViewDataSource, UICollectionViewDelegate, UICollectionViewDataSourcePrefetching {
    public weak var delegate: ThumbnailStripDelegate?
    public let pipeline: ImagePipeline
    public let itemSize: CGSize
    public private(set) var keys: [String] = []
    public let collectionView: UICollectionView
    private var tickets: [Int: ImageTicket] = [:]
    private var prefetched: [Int: ImageTicket] = [:]
    // Failed thumbnails: attempts so far (asked again after 1, 2, 4... up to 30 seconds while
    // on screen, as a dropped connection comes back).
    private var failures: [Int: Int] = [:]

    public init(pipeline: ImagePipeline, itemSize: CGSize = CGSize(width: 100, height: 300)) {
        self.pipeline = pipeline
        self.itemSize = itemSize
        let layout = UICollectionViewFlowLayout()
        layout.scrollDirection = .horizontal
        layout.itemSize = itemSize
        layout.minimumLineSpacing = 0
        layout.minimumInteritemSpacing = 0
        collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
        super.init(frame: .zero)
        collectionView.backgroundColor = .black
        collectionView.showsHorizontalScrollIndicator = false
        collectionView.alwaysBounceHorizontal = false
        collectionView.contentInsetAdjustmentBehavior = .never
        collectionView.scrollsToTop = false
        collectionView.dataSource = self
        collectionView.delegate = self
        collectionView.prefetchDataSource = self
        collectionView.register(ThumbnailCell.self, forCellWithReuseIdentifier: "thumb")
        addSubview(collectionView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override public func layoutSubviews() {
        super.layoutSubviews()
        collectionView.frame = bounds
    }

    public func setKeys(_ keys: [String], offset: CGFloat = 0) {
        cancelAll()
        failures.removeAll()
        self.keys = keys
        collectionView.reloadData()
        collectionView.layoutIfNeeded()
        self.offset = offset
    }

    public var offset: CGFloat {
        get { collectionView.contentOffset.x }
        set {
            let maxOffset = max(0, CGFloat(keys.count) * itemSize.width - collectionView.bounds.width)
            collectionView.contentOffset = CGPoint(x: min(max(0, newValue), maxOffset), y: 0)
        }
    }

    // Images that failed are asked again (a thumbnail that finished downloading).
    public func reloadMissing() {
        for cell in collectionView.visibleCells.compactMap({ $0 as? ThumbnailCell }) where cell.imageView.image == nil {
            if let index = collectionView.indexPath(for: cell)?.item { load(index, into: cell) }
        }
    }

    public func cancelAll() {
        tickets.values.forEach { $0.cancel() }
        prefetched.values.forEach { $0.cancel() }
        tickets.removeAll()
        prefetched.removeAll()
    }

    public var decodedCount: Int { collectionView.visibleCells.compactMap { ($0 as? ThumbnailCell)?.imageView.image }.count }

    // MARK: data

    public func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { keys.count }

    public func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "thumb", for: indexPath) as! ThumbnailCell
        load(indexPath.item, into: cell)
        return cell
    }

    public func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        tickets.removeValue(forKey: indexPath.item)?.cancel()
    }

    public func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
        for indexPath in indexPaths where prefetched[indexPath.item] == nil && keys.indices.contains(indexPath.item) {
            prefetched[indexPath.item] = pipeline.load(request(indexPath.item)) { [weak self] _ in self?.prefetched[indexPath.item] = nil }
        }
    }

    public func collectionView(_ collectionView: UICollectionView, cancelPrefetchingForItemsAt indexPaths: [IndexPath]) {
        for indexPath in indexPaths { prefetched.removeValue(forKey: indexPath.item)?.cancel() }
    }

    public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        delegate?.strip(self, didSelect: indexPath.item)
    }

    public func scrollViewDidScroll(_ scrollView: UIScrollView) {
        pipeline.prioritiesChanged()
        if scrollView.isDragging || scrollView.isDecelerating { delegate?.stripDidScroll(self) }
    }

    // The first thumbnail on screen.
    public var firstVisibleIndex: Int { max(0, Int(collectionView.contentOffset.x / max(itemSize.width, 1))) }
    public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { if !decelerate { delegate?.stripDidSettle(self) } }
    public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { delegate?.stripDidSettle(self) }

    private var fit: ImageFit {
        let scale = window?.screen.scale ?? 3
        return .cover(width: Int(itemSize.width * scale), height: Int(itemSize.height * scale))
    }

    private func request(_ index: Int) -> ImagePipeline.Request {
        let key = keys[index]
        return ImagePipeline.Request(key: key, source: delegate?.strip(self, sourceFor: index) ?? .load({ throw CancellationError() }), fit: fit,
                                     localFile: delegate?.strip(self, localFileFor: index)) { [weak self] in
            self?.distanceFromScreen(index) ?? .infinity
        }
    }

    private func load(_ index: Int, into cell: ThumbnailCell) {
        tickets.removeValue(forKey: index)?.cancel()
        cell.index = index
        if let image = pipeline.cached(keys[index], fit: fit) { cell.imageView.image = image; return }
        cell.imageView.image = nil
        tickets[index] = pipeline.load(request(index)) { [weak self, weak cell] result in
            guard let self, let cell, cell.index == index else { return }
            tickets[index] = nil
            switch result {
            case .success(let image):
                failures[index] = nil
                cell.imageView.image = image
            case .failure(let error):
                if error is CancellationError { return }
                let attempts = (failures[index] ?? 0) + 1
                failures[index] = attempts
                let keys = keys
                DispatchQueue.main.asyncAfter(deadline: .now() + min(30, pow(2, Double(attempts - 1)))) { [weak self, weak cell] in
                    guard let self, let cell, self.keys == keys, cell.index == index, cell.window != nil,
                          cell.imageView.image == nil, tickets[index] == nil else { return }
                    load(index, into: cell)
                }
            }
        }
    }

    // Distance in points from the screen, both axes (0 on screen).
    private func distanceFromScreen(_ index: Int) -> Double {
        guard let window else { return .infinity }
        let frame = CGRect(x: CGFloat(index) * itemSize.width - collectionView.contentOffset.x, y: 0, width: itemSize.width, height: itemSize.height)
        let onScreen = convert(frame, to: window)
        let screen = window.bounds
        let dx = onScreen.maxX < screen.minX ? screen.minX - onScreen.maxX : onScreen.minX > screen.maxX ? onScreen.minX - screen.maxX : 0
        let dy = onScreen.maxY < screen.minY ? screen.minY - onScreen.maxY : onScreen.minY > screen.maxY ? onScreen.minY - screen.maxY : 0
        return Double(dx + dy)
    }
}

final class ThumbnailCell: UICollectionViewCell {
    let imageView = UIImageView()
    var index = -1

    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        imageView.backgroundColor = UIColor(white: 0.063, alpha: 1)
        contentView.addSubview(imageView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is unused") }

    override func layoutSubviews() {
        super.layoutSubviews()
        imageView.frame = contentView.bounds
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        imageView.image = nil
        index = -1
    }
}
#endif
