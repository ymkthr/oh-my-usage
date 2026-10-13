import AppKit

/// The macOS counterpart of src/indicator.js: the status item shows the panel,
/// the menu shows everything else in `View`.
@MainActor
final class StatusItemController: NSObject, NSMenuDelegate, NSWindowDelegate {
    private enum Metrics {
        // NSMenu adds about 4 pt before an item view, so these land on the
        // checkmark column and on the title text of standard items.
        static let edge: CGFloat = 10
        static let indent: CGFloat = 24
        static let panelBar = NSSize(width: 16, height: 5)
        static let panelBarGap: CGFloat = 2
        static let rowColumn: CGFloat = 110
        static let rowMinWidth: CGFloat = 370
        static let rowBarHeight: CGFloat = 6
        static let noticeMaxWidth: CGFloat = 360
    }

    private let store: UsageStore
    private let settings: Settings
    private let script: ModelScript
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private lazy var settingsWindow: NSWindow = {
        let window = makeSettingsWindow(settings)
        window.delegate = self
        return window
    }()

    init(store: UsageStore, settings: Settings, script: ModelScript) {
        self.store = store
        self.settings = settings
        self.script = script
        super.init()
        menu.delegate = self
        statusItem.menu = menu
        render()
    }

    func render() {
        let view = script.render(store.state, primaryAccount: settings.primaryAccount, now: .now)
        applyPanel(view.panel)
        rebuildMenu(view)
    }

    func menuWillOpen(_ menu: NSMenu) {
        store.refresh(.read)
    }

    private func applyPanel(_ panel: PanelView) {
        guard let button = statusItem.button else { return }
        let size = NSFont.menuBarFont(ofSize: 0).pointSize
        let hasBars = !panel.bars.isEmpty
        let showBars = settings.panelDisplay != .textOnly && hasBars
        let showText = settings.panelDisplay != .barsOnly || !hasBars

        let title = NSMutableAttributedString()
        if showText {
            let normal: NSColor = panel.stale ? .secondaryLabelColor : .labelColor
            title.append(NSAttributedString(string: panel.text, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular),
                .foregroundColor: color(of: panel.level, normal: normal),
            ]))
        }
        if let alert = panel.alert {
            if title.length > 0 {
                title.append(NSAttributedString(string: "  "))
            }
            title.append(NSAttributedString(string: alert.text, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: .bold),
                .foregroundColor: color(of: alert.level, normal: .labelColor),
            ]))
        }
        if showBars && title.length > 0 {
            title.insert(NSAttributedString(string: " "), at: 0)
        }

        button.image = showBars ? panelBarsImage(panel.bars) : nil
        button.imagePosition = title.length == 0 ? .imageOnly : .imageLeading
        button.attributedTitle = title
    }

    private func panelBarsImage(_ bars: [BarView]) -> NSImage {
        let bar = Metrics.panelBar
        let gap = Metrics.panelBarGap
        let height = CGFloat(bars.count) * bar.height + CGFloat(bars.count - 1) * gap
        // A drawing-handler image redraws per appearance. The menu bar tints
        // with the wallpaper, where accent blue on a 5% bar disappears, so the
        // normal fill uses the label colour like the system's own items.
        return NSImage(size: NSSize(width: bar.width, height: height), flipped: true) { _ in
            for (i, view) in bars.enumerated() {
                let rect = NSRect(origin: NSPoint(x: 0, y: CGFloat(i) * (bar.height + gap)), size: bar)
                drawBar(in: rect, fraction: view.fraction, level: view.level, normal: .labelColor)
            }
            return true
        }
    }

    private func rebuildMenu(_ view: View) {
        menu.removeAllItems()

        let header = spread(
            label("LLM usage", font: .boldSystemFont(ofSize: menuFontSize)),
            label(view.status, color: view.statusLevel == .error ? .systemRed : .secondaryLabelColor))
        menu.addItem(viewItem(header, leading: Metrics.edge))
        menu.addItem(.separator())

        for alert in view.alerts {
            let detail = label(alert.detail, font: digitsFont, color: color(of: alert.level, normal: .labelColor))
            detail.alignment = .right
            detail.widthAnchor.constraint(equalToConstant: Metrics.rowColumn).isActive = true
            menu.addItem(viewItem(spread(label("\(alert.title) · \(alert.label)"), detail), leading: Metrics.indent))
        }
        if !view.alerts.isEmpty {
            menu.addItem(.separator())
        }

        if let notice = view.notice {
            let text = NSTextField(wrappingLabelWithString: notice)
            text.font = .menuFont(ofSize: 0)
            text.preferredMaxLayoutWidth = Metrics.noticeMaxWidth
            text.widthAnchor.constraint(lessThanOrEqualToConstant: Metrics.noticeMaxWidth).isActive = true
            menu.addItem(viewItem(NSStackView(views: [text]), leading: Metrics.edge))
        }

        for (i, provider) in view.providers.enumerated() {
            if i > 0 {
                menu.addItem(.separator())
            }
            let title = label(provider.title, font: .boldSystemFont(ofSize: menuFontSize * 1.05), color: .controlAccentColor)
            menu.addItem(viewItem(spread(title, label(provider.count, color: .secondaryLabelColor)), leading: Metrics.edge))
            for section in provider.accounts {
                menu.addItem(accountTitleItem(section))
                menu.addItem(viewItem(sectionBody(section), leading: Metrics.indent))
            }
        }

        menu.addItem(.separator())
        menu.addItem(actionItem("Refresh now (invalidate cache)", #selector(refreshNow)))
        menu.addItem(actionItem("Settings…", #selector(openSettings)))
        menu.addItem(actionItem("Quit oh-my-usage", #selector(quit)))
    }

    private func accountTitleItem(_ section: SectionView) -> NSMenuItem {
        let item = actionItem(section.title, #selector(choosePrimary(_:)))
        item.representedObject = section.key
        item.state = section.primary ? .on : .off
        if let badge = section.badge {
            item.badge = NSMenuItemBadge(string: badge)
        }
        return item
    }

    private func sectionBody(_ section: SectionView) -> NSStackView {
        var lines: [NSView] = []
        if !section.subtitle.isEmpty {
            lines.append(label(section.subtitle, font: .systemFont(ofSize: menuFontSize * 0.9), color: .secondaryLabelColor))
        }
        lines += section.rows.map(rowLine)
        let column = NSStackView(views: lines)
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 4
        return column
    }

    private func rowLine(_ row: RowView) -> NSView {
        let name = label(row.label)
        name.widthAnchor.constraint(equalToConstant: Metrics.rowColumn).isActive = true
        let bar = UsageBarView(fraction: row.fraction, level: row.level)
        bar.heightAnchor.constraint(equalToConstant: Metrics.rowBarHeight).isActive = true
        bar.setContentHuggingPriority(.init(1), for: .horizontal)
        let detail = label(row.detail, font: digitsFont, color: color(of: row.level, normal: .labelColor))
        detail.alignment = .right
        detail.widthAnchor.constraint(equalToConstant: Metrics.rowColumn).isActive = true

        let line = NSStackView(views: [name, bar, detail])
        line.spacing = 10
        line.widthAnchor.constraint(greaterThanOrEqualToConstant: Metrics.rowMinWidth).isActive = true
        return line
    }

    private func actionItem(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    @objc private func choosePrimary(_ sender: NSMenuItem) {
        settings.primaryAccount = sender.representedObject as? String ?? ""
    }

    @objc private func refreshNow() {
        store.refresh(.invalidate)
    }

    /// NSApp.activate() from an accessory app's menu action is refused (seen on
    /// macOS 26), leaving the window behind the active app without keyboard
    /// focus. The app turns regular, with a Dock icon, only while it is open.
    @objc private func openSettings() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
        settingsWindow.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

/// A full-width row whose leading view takes the slack, so the trailing view
/// sits at the right edge of the menu.
@MainActor
private func spread(_ leading: NSView, _ trailing: NSView) -> NSStackView {
    leading.setContentHuggingPriority(.init(1), for: .horizontal)
    leading.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let row = NSStackView(views: [leading, trailing])
    row.spacing = 12
    return row
}

/// NSMenu stretches an item view with a flexible width to the menu width.
@MainActor
private func viewItem(_ content: NSStackView, leading: CGFloat) -> NSMenuItem {
    content.edgeInsets = NSEdgeInsets(top: 3, left: leading, bottom: 3, right: 14)
    content.setFrameSize(content.fittingSize)
    content.autoresizingMask = [.width]
    let item = NSMenuItem()
    item.view = content
    return item
}

@MainActor
private var menuFontSize: CGFloat { NSFont.menuFont(ofSize: 0).pointSize }

@MainActor
private var digitsFont: NSFont { .monospacedDigitSystemFont(ofSize: menuFontSize, weight: .regular) }

@MainActor
private func label(_ text: String, font: NSFont = .menuFont(ofSize: 0), color: NSColor = .labelColor) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = font
    field.textColor = color
    field.lineBreakMode = .byTruncatingTail
    return field
}

private func color(of level: Level, normal: NSColor) -> NSColor {
    switch level {
    case .normal: normal
    case .warning: .systemOrange
    case .error: .systemRed
    }
}

private func drawBar(in rect: NSRect, fraction: Double, level: Level, normal: NSColor = .controlAccentColor) {
    let radius = rect.height / 2
    let track = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
    NSColor.gray.withAlphaComponent(0.3).setFill()
    track.fill()
    NSGraphicsContext.saveGraphicsState()
    track.addClip()
    color(of: level, normal: normal).setFill()
    NSRect(x: rect.minX, y: rect.minY, width: (rect.width * fraction).rounded(), height: rect.height).fill()
    NSGraphicsContext.restoreGraphicsState()
}

private final class UsageBarView: NSView {
    private let fraction: Double
    private let level: Level

    init(fraction: Double, level: Level) {
        self.fraction = fraction
        self.level = level
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func draw(_ dirtyRect: NSRect) {
        drawBar(in: bounds, fraction: fraction, level: level)
    }
}
