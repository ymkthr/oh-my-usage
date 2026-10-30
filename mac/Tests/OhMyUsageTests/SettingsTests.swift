import Foundation
import XCTest
@testable import OhMyUsage

@MainActor
final class SettingsTests: XCTestCase {
    private final class FakeLoginItem: LoginItem {
        var isEnabled = false
        var failing = false

        func setEnabled(_ enabled: Bool) throws {
            if failing {
                throw CocoaError(.featureUnsupported)
            }
            isEnabled = enabled
        }
    }

    private func makeDefaults() -> UserDefaults {
        let name = "SettingsTests-\(UUID().uuidString)"
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
        return UserDefaults(suiteName: name)!
    }

    func testFirstLaunchOpensAtLogin() {
        let item = FakeLoginItem()

        let settings = Settings(defaults: makeDefaults(), loginItem: item)

        XCTAssertTrue(item.isEnabled)
        XCTAssertTrue(settings.launchAtLogin)
    }

    func testTurningItOffSurvivesTheNextLaunch() {
        let defaults = makeDefaults()
        let item = FakeLoginItem()
        Settings(defaults: defaults, loginItem: item).launchAtLogin = false

        let relaunched = Settings(defaults: defaults, loginItem: item)

        XCTAssertFalse(item.isEnabled, "the default applies once, not on every launch")
        XCTAssertFalse(relaunched.launchAtLogin)
    }

    func testAFailedFirstAttemptIsRetriedOnTheNextLaunch() {
        let defaults = makeDefaults()
        let item = FakeLoginItem()
        item.failing = true
        _ = Settings(defaults: defaults, loginItem: item)
        item.failing = false

        _ = Settings(defaults: defaults, loginItem: item)

        XCTAssertTrue(item.isEnabled)
    }

    func testAFailedToggleShowsWhyAndKeepsTheSystemState() {
        let item = FakeLoginItem()
        let settings = Settings(defaults: makeDefaults(), loginItem: item)
        item.failing = true

        settings.launchAtLogin = false

        XCTAssertTrue(settings.launchAtLogin, "the toggle reflects what the system holds")
        XCTAssertNotNil(settings.launchAtLoginError)
    }
}
