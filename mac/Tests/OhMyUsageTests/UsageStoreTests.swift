import Foundation
import XCTest
@testable import OhMyUsage

@MainActor
final class UsageStoreTests: XCTestCase {
    private var model: ModelScript!

    override func setUp() async throws {
        model = try loadModel()
    }

    private func makeStore(ompPath: String = fakeOmpPath, interval: Int = 0, watchdog: TimeInterval = 60) -> UsageStore {
        let store = UsageStore(script: model, ompPath: ompPath, intervalSeconds: interval, watchdogSeconds: watchdog)
        addTeardownBlock { @MainActor in store.destroy() }
        return store
    }

    private func render(_ store: UsageStore) -> View {
        model.render(store.state, primaryAccount: "", now: .now)
    }

    func testReadPublishesSnapshotAndPolicies() async throws {
        let fake = FakeOmp()
        let store = makeStore()
        var published: [Bool] = []
        store.onChange = { published.append(store.state.inFlight) }

        store.refresh(.read)
        try await settled(store)

        XCTAssertEqual(published, [true, false], "changed fires for in-flight then idle")
        XCTAssertNil(store.state.error)
        XCTAssertEqual(fake.lines, ["usage --json", policiesLine], "usage then policies")
        let view = render(store)
        XCTAssertEqual(view.providers.map(\.title), ["Anthropic", "OpenAI Codex", "OpenCode Go"])
        XCTAssertEqual(view.providers[1].accounts.map(\.subtitle), ["team · priority 10", "plus · priority 1"])
    }

    func testRequestsDuringARefreshMergeIntoOneFollowUp() async throws {
        let fake = FakeOmp()
        let store = makeStore()
        var changes = 0
        store.onChange = { changes += 1 }

        store.refresh(.read)
        store.refresh(.invalidate)
        store.refresh(.read)
        store.refresh(.read)
        XCTAssertTrue(store.state.inFlight)
        try await settled(store)

        XCTAssertEqual(fake.lines, ["usage --json", policiesLine, "usage invalidate", "usage --json", policiesLine])
        XCTAssertEqual(changes, 2, "one drain, two changes")

        store.refresh(.read)
        try await settled(store)
        XCTAssertEqual(fake.lines.count, 7, "a later refresh runs again")
    }

    func testFailedReadKeepsTheSnapshotAndReportsTheStderrHead() async throws {
        let fake = FakeOmp()
        let store = makeStore()
        store.refresh(.read)
        try await settled(store)
        let good = try XCTUnwrap(store.state.snapshot)

        setenv("FAKE_OMP_MODE", "fail", 1)
        store.refresh(.read)
        try await settled(store)
        XCTAssertTrue(store.state.snapshot === good, "snapshot retained")
        XCTAssertEqual(store.state.error, .exit(status: 1, stderrHead: "AuthBrokerError: Auth broker request failed after 2 attempt(s)"))
        XCTAssertTrue(render(store).panel.stale)

        setenv("FAKE_OMP_MODE", "ok", 1)
        store.refresh(.read)
        try await settled(store)
        XCTAssertNil(store.state.error, "success clears the error")
        XCTAssertFalse(store.state.snapshot === good, "success replaces the snapshot")
        XCTAssertEqual(fake.lines, ["usage --json", policiesLine, "usage --json", "usage --json", policiesLine])
    }

    func testFailedPolicyReadKeepsThePreviousPolicies() async throws {
        let fake = FakeOmp()
        let store = makeStore()
        store.refresh(.read)
        try await settled(store)
        let policies = store.state.policies
        let good = store.state.snapshot

        setenv("FAKE_OMP_POLICY_MODE", "fail", 1)
        defer { unsetenv("FAKE_OMP_POLICY_MODE") }
        store.refresh(.read)
        try await settled(store)

        XCTAssertNil(store.state.error)
        XCTAssertNotNil(store.state.snapshot)
        XCTAssertFalse(store.state.snapshot === good, "the new snapshot is published")
        XCTAssertTrue(store.state.policies === policies, "previous policies kept")
        XCTAssertEqual(fake.lines, ["usage --json", policiesLine, "usage --json", policiesLine])
    }

    func testMissingBinarySpawnsNothingAndNamesThePath() async throws {
        let fake = FakeOmp()
        let store = makeStore(ompPath: "/nonexistent/omp")
        var published: [Bool] = []
        store.onChange = { published.append(store.state.inFlight) }

        store.refresh(.invalidate)
        try await settled(store)
        XCTAssertEqual(store.state.error, .missingBinary(path: "/nonexistent/omp"))
        XCTAssertEqual(fake.lines, [], "nothing was spawned")
        XCTAssertEqual(published, [true, false])

        store.configure(ompPath: fakeOmpPath, intervalSeconds: 0)
        store.refresh(.read)
        try await settled(store)
        XCTAssertNil(store.state.error, "a corrected path recovers")
        XCTAssertEqual(fake.lines, ["usage --json", policiesLine])
    }

    func testOmpInterpreterOnlyOnTheLoginShellPathStillRuns() async throws {
        let fake = FakeOmp()
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("login-path-\(UUID().uuidString)")
        let bin = dir.appendingPathComponent("bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let interpreter = bin.appendingPathComponent("fake-bun")
        try "#!/bin/sh\nexec /bin/sh \"$@\"\n".write(to: interpreter, atomically: true, encoding: .utf8)
        let omp = dir.appendingPathComponent("omp")
        try "#!/usr/bin/env fake-bun\nexec '\(fakeOmpPath)' \"$@\"\n".write(to: omp, atomically: true, encoding: .utf8)
        for file in [interpreter, omp] {
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        }
        setenv("FAKE_LOGIN_PATH", bin.path, 1)
        let store = makeStore(ompPath: omp.path)

        store.refresh(.read)
        try await settled(store)

        XCTAssertNil(store.state.error, "the shebang interpreter resolves through the login PATH")
        XCTAssertEqual(fake.lines, ["usage --json", policiesLine])
    }

    func testDestroyDuringAReadKillsTheChildAndGoesSilent() async throws {
        let fake = FakeOmp(mode: "hang")
        let before = Set(childPids())
        let store = makeStore()
        var changes = 0
        store.onChange = { changes += 1 }

        store.refresh(.read)
        var child: pid_t?
        let started = try await until {
            child = fake.lines.count == 1 ? Set(childPids()).subtracting(before).first : nil
            return child != nil
        }
        XCTAssertTrue(started, "child is running after its start line")
        let pid = try XCTUnwrap(child)
        XCTAssertEqual(changes, 1, "in flight before destroy")

        store.destroy()
        store.refresh(.read)
        let gone = try await until { !isAlive(pid) }
        XCTAssertTrue(gone, "child is gone")
        try await Task.sleep(for: .milliseconds(300))

        XCTAssertEqual(changes, 1, "nothing published after destroy")
        XCTAssertNil(store.state.snapshot)
        XCTAssertNil(store.state.error)
        XCTAssertFalse(store.state.inFlight)
        XCTAssertEqual(fake.lines, ["usage --json"], "refresh after destroy spawned nothing")
        store.destroy()
    }

    func testWatchdogKillsAHungChild() async throws {
        _ = FakeOmp(mode: "hang")
        let store = makeStore(watchdog: 0.5)

        store.refresh(.read)
        try await settled(store)

        XCTAssertEqual(store.state.error, .exit(status: 128 + SIGKILL, stderrHead: ""))
    }

    func testTimerOnlyReadsAndDestroyStopsIt() async throws {
        let fake = FakeOmp()
        let store = makeStore(interval: 1)

        let ticked = try await until(timeout: 3) { fake.lines.count >= 2 }
        XCTAssertTrue(ticked, "first tick arrives")
        XCTAssertEqual(fake.lines, ["usage --json", policiesLine], "a tick is a plain read")

        store.destroy()
        try await settled(store)
        let after = fake.lines.count
        try await Task.sleep(for: .milliseconds(1500))
        XCTAssertEqual(fake.lines.count, after, "destroy stops the ticks")
    }
}
