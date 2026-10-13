import AppKit

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

guard let modelURL = Bundle.main.url(forResource: "model", withExtension: "js") else {
    fatalError("model.js is missing from the app bundle's Resources")
}
let script = try ModelScript(contentsOf: modelURL)
let settings = Settings()
let store = UsageStore(script: script, ompPath: settings.ompPath, intervalSeconds: settings.refreshInterval)
let controller = StatusItemController(store: store, settings: settings, script: script)

store.onChange = { controller.render() }
settings.onChange = { key in
    switch key {
    case .ompPath:
        store.configure(ompPath: settings.ompPath, intervalSeconds: settings.refreshInterval)
        store.refresh(.read)
    case .refreshInterval:
        store.configure(ompPath: settings.ompPath, intervalSeconds: settings.refreshInterval)
    case .panelDisplay, .primaryAccount:
        controller.render()
    }
}
let terminationObserver = NotificationCenter.default.addObserver(
    forName: NSApplication.willTerminateNotification, object: nil, queue: .main
) { _ in
    MainActor.assumeIsolated { store.destroy() }
}

store.refresh(.read)
app.run()
