import AppKit
import Observation
import SwiftUI

enum PanelDisplay: String, CaseIterable {
    case barsAndText = "bars-and-text"
    case barsOnly = "bars-only"
    case textOnly = "text-only"

    var label: String {
        switch self {
        case .barsAndText: "Bars and text"
        case .barsOnly: "Bars only"
        case .textOnly: "Text only"
        }
    }
}

/// The gschema keys in UserDefaults. Reads go through the argument domain,
/// so `-ompPath /x` on the command line overrides the saved value.
@MainActor
@Observable
final class Settings {
    enum Key: String {
        case ompPath, refreshInterval, panelDisplay, primaryAccount
    }

    static let intervalRange = 30...3600

    @ObservationIgnored var onChange: @MainActor (Key) -> Void = { _ in }
    @ObservationIgnored private let defaults: UserDefaults

    var ompPath: String {
        didSet { save(.ompPath, ompPath, changed: ompPath != oldValue) }
    }
    var refreshInterval: Int {
        didSet { save(.refreshInterval, refreshInterval, changed: refreshInterval != oldValue) }
    }
    var panelDisplay: PanelDisplay {
        didSet { save(.panelDisplay, panelDisplay.rawValue, changed: panelDisplay != oldValue) }
    }
    var primaryAccount: String {
        didSet { save(.primaryAccount, primaryAccount, changed: primaryAccount != oldValue) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        ompPath = defaults.string(forKey: Key.ompPath.rawValue) ?? ""
        let interval = defaults.object(forKey: Key.refreshInterval.rawValue) == nil
            ? 300 : defaults.integer(forKey: Key.refreshInterval.rawValue)
        refreshInterval = min(max(interval, Self.intervalRange.lowerBound), Self.intervalRange.upperBound)
        panelDisplay = PanelDisplay(rawValue: defaults.string(forKey: Key.panelDisplay.rawValue) ?? "") ?? .barsAndText
        primaryAccount = defaults.string(forKey: Key.primaryAccount.rawValue) ?? ""
    }

    private func save(_ key: Key, _ value: Any, changed: Bool) {
        guard changed else { return }
        defaults.set(value, forKey: key.rawValue)
        onChange(key)
    }
}

@MainActor
func makeSettingsWindow(_ settings: Settings) -> NSWindow {
    let window = NSWindow(contentViewController: NSHostingController(rootView: SettingsForm(settings: settings)))
    window.title = "oh-my-usage"
    window.styleMask = [.titled, .closable]
    window.isReleasedWhenClosed = false
    window.center()
    return window
}

private struct SettingsForm: SwiftUI.View {
    @Bindable var settings: Settings
    @State private var draftPath: String

    init(settings: Settings) {
        self.settings = settings
        _draftPath = State(initialValue: settings.ompPath)
    }

    var body: some SwiftUI.View {
        Form {
            Section {
                HStack {
                    TextField("omp binary", text: $draftPath)
                        .onSubmit { settings.ompPath = draftPath }
                    Button("Apply") { settings.ompPath = draftPath }
                        .disabled(draftPath == settings.ompPath)
                }
                Stepper(value: $settings.refreshInterval, in: Settings.intervalRange, step: 30) {
                    LabeledContent {
                        Text(verbatim: "\(settings.refreshInterval)")
                            .monospacedDigit()
                    } label: {
                        Text("Refresh interval")
                        Text("Seconds between reads; the timer never invalidates the cache")
                    }
                }
            } header: {
                Text("Data")
            } footer: {
                Text(verbatim: "Leave the path empty to use \(defaultOmpPath()).")
            }

            Section("Panel") {
                Picker("Menu bar shows", selection: $settings.panelDisplay) {
                    ForEach(PanelDisplay.allCases, id: \.self) { Text($0.label).tag($0) }
                }
            }

            Section {
                LabeledContent {
                    Button("Use first account") { settings.primaryAccount = "" }
                        .disabled(settings.primaryAccount.isEmpty)
                } label: {
                    Text("Account shown in the menu bar")
                    Text(verbatim: settings.primaryAccount.isEmpty ? "first account" : settings.primaryAccount)
                }
            } header: {
                Text("Primary account")
            } footer: {
                Text("Pick an account by clicking its title in the menu.")
            }
        }
        .formStyle(.grouped)
        .scrollDisabled(true)
        .fixedSize(horizontal: false, vertical: true)
        .frame(width: 480)
        .onChange(of: settings.ompPath) { draftPath = settings.ompPath }
    }
}
