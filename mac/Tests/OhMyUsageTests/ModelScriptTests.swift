import Foundation
import XCTest
@testable import OhMyUsage

/// usage.json's generatedAt, so ages and remaining times are fixed.
private let fixtureNow = Date(timeIntervalSince1970: 1_791_328_899.152)

@MainActor
final class ModelScriptTests: XCTestCase {
    private func fixtureState(_ model: ModelScript) throws -> StoreState {
        StoreState(
            snapshot: try model.parseUsage(fixture("usage.json")),
            policies: try XCTUnwrap(model.parsePolicies(fixture("config.json"))),
            error: nil,
            inFlight: false)
    }

    func testFixtureRendersTheView() throws {
        let model = try loadModel()
        let view = model.render(try fixtureState(model), primaryAccount: "", now: fixtureNow)

        XCTAssertEqual(view.panel.text, "5h 5% · 7d 12%")
        XCTAssertEqual(view.panel.bars.map(\.fraction), [0.05, 0.12])
        XCTAssertEqual(view.panel.level, .normal)
        XCTAssertFalse(view.panel.stale)
        XCTAssertEqual(view.panel.alert?.text, "⚠ Go 1mo 93% +1")
        XCTAssertEqual(view.panel.alert?.level, .error)
        XCTAssertEqual(view.status, "updated just now")
        XCTAssertNil(view.notice)
        XCTAssertEqual(view.providers.map(\.title), ["Anthropic", "OpenAI Codex", "OpenCode Go"])
        XCTAssertEqual(view.providers.map(\.count), ["1 account", "2 accounts", "1 account"])

        let codex = view.providers[1].accounts
        XCTAssertEqual(codex.map(\.subtitle), ["team · priority 10", "plus · priority 1"], "policies order the accounts")
        XCTAssertEqual(codex.map(\.badge), ["✦ 1 reset", "✦ 2 resets"])
        XCTAssertEqual(codex[1].rows.map(\.detail), ["10% · 4h29m", "84% · 6d9h"])
        XCTAssertEqual(codex[1].rows.map(\.level), [.normal, .warning])
        XCTAssertEqual(view.providers[0].accounts.map(\.primary), [true])

        XCTAssertEqual(view.alerts.map(\.title), ["OpenCode Go", "OpenAI Codex · plus"])
        XCTAssertEqual(view.alerts.map(\.detail), ["93% · 6d5h", "84% · 6d9h"])
        XCTAssertEqual(view.alerts.map(\.level), [.error, .warning])
    }

    func testPrimaryAccountMovesThePanel() throws {
        let model = try loadModel()
        let view = model.render(try fixtureState(model), primaryAccount: "openai-codex:personal@example.com", now: fixtureNow)

        XCTAssertEqual(view.panel.text, "5h 10% · 7d 84%")
        XCTAssertEqual(view.panel.level, .warning)
        XCTAssertEqual(view.providers.flatMap(\.accounts).filter(\.primary).map(\.key), ["openai-codex:personal@example.com"])
    }

    func testMissingBinaryWithoutSnapshotIsANotice() throws {
        let model = try loadModel()
        let state = StoreState(
            snapshot: nil, policies: model.emptyPolicies(), error: .missingBinary(path: "/nonexistent/omp"), inFlight: false)
        let view = model.render(state, primaryAccount: "", now: fixtureNow)

        XCTAssertEqual(view.notice, "omp not found at /nonexistent/omp. Set the path in Settings.")
        XCTAssertTrue(view.providers.isEmpty)
        XCTAssertEqual(view.statusLevel, .error)
        XCTAssertEqual(view.panel.text, "!")
        XCTAssertEqual(view.panel.level, .error)
    }

    func testExitErrorAfterASnapshotMarksThePanelStale() throws {
        let model = try loadModel()
        var state = try fixtureState(model)
        state.error = .exit(status: 1, stderrHead: "boom")
        let view = model.render(state, primaryAccount: "", now: fixtureNow.addingTimeInterval(120))

        XCTAssertEqual(view.status, "update failed · last 2 min ago")
        XCTAssertEqual(view.statusLevel, .error)
        XCTAssertTrue(view.panel.stale)
        XCTAssertNil(view.notice)
    }

    func testUnparsableUsageIsInvalidJSON() throws {
        let model = try loadModel()
        XCTAssertThrowsError(try model.parseUsage("not json")) { error in
            guard case .invalidJSON(let detail) = error as? FetchError else {
                return XCTFail("expected invalidJSON, got \(error)")
            }
            XCTAssertFalse(detail.isEmpty)
        }
    }
}
