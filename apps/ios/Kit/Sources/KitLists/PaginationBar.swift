#if canImport(UIKit)
import UIKit

// The gallery apps' page links: "Favs", then every page number, the current one bold white
// and not a link; wraps onto as many lines as it needs.
@MainActor
public final class PaginationBar: UIView {
    public var onFavorites: (() -> Void)?
    public var onPage: ((Int) -> Void)?
    private var buttons: [UIButton] = []
    private var lastWidth: CGFloat = 0

    public private(set) var page = 1
    public private(set) var pageCount = 1

    public func set(page: Int, of pageCount: Int) {
        guard page != self.page || pageCount != self.pageCount || buttons.isEmpty else { return }
        self.page = page
        self.pageCount = pageCount
        buttons.forEach { $0.removeFromSuperview() }
        buttons = [button("Favs", bold: false, enabled: true) { [weak self] in self?.onFavorites?() }]
        for number in 1...max(1, pageCount) {
            buttons.append(button(String(number), bold: number == page, enabled: number != page) { [weak self] in self?.onPage?(number) })
        }
        buttons.forEach(addSubview)
        invalidateIntrinsicContentSize()
        setNeedsLayout()
    }

    private func button(_ title: String, bold: Bool, enabled: Bool, action: @escaping () -> Void) -> UIButton {
        var configuration = UIButton.Configuration.plain()
        configuration.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
        configuration.attributedTitle = AttributedString(title, attributes: AttributeContainer([
            .font: bold ? UIFont.boldSystemFont(ofSize: 16) : UIFont.systemFont(ofSize: 16),
            .foregroundColor: bold ? UIColor.white : UIColor(white: 0.53, alpha: 1),
        ]))
        let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
        button.isUserInteractionEnabled = enabled
        return button
    }

    override public func layoutSubviews() {
        super.layoutSubviews()
        _ = arrange(width: bounds.width, apply: true)
    }

    override public func sizeThatFits(_ size: CGSize) -> CGSize { CGSize(width: size.width, height: arrange(width: size.width, apply: false)) }

    override public var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: arrange(width: bounds.width > 0 ? bounds.width : 400, apply: false)) }

    private func arrange(width: CGFloat, apply: Bool) -> CGFloat {
        var x: CGFloat = 4, y: CGFloat = 8, rowHeight: CGFloat = 0
        for (index, button) in buttons.enumerated() {
            let size = button.intrinsicContentSize
            if x + size.width > width - 4, x > 4 { x = 4; y += rowHeight + 4; rowHeight = 0 }
            if apply { button.frame = CGRect(origin: CGPoint(x: x, y: y), size: size) }
            x += size.width + (index == 0 ? 12 : 4)
            rowHeight = max(rowHeight, size.height)
        }
        return y + rowHeight + 8
    }
}
#endif
