import Foundation
import JavaScriptCore
import XCTest
@testable import OhMyUsage

let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
let fixtures = repoRoot.appendingPathComponent("tests/fixtures")
let fakeOmpPath = fixtures.appendingPathComponent("fake-omp").path
let fakeShellPath = fixtures.appendingPathComponent("fake-shell").path
let policiesLine = "config get auth.accountPolicies --json"

@MainActor
func loadModel() throws -> ModelScript {
    try ModelScript(contentsOf: repoRoot.appendingPathComponent("src/model.js"))
}

func fixture(_ name: String) throws -> String {
    try String(contentsOf: fixtures.appendingPathComponent(name), encoding: .utf8)
}

/// Points tests/fixtures/fake-omp at a fresh log through the environment the
/// store's children inherit.
struct FakeOmp {
    let log = FileManager.default.temporaryDirectory.appendingPathComponent("fake-omp-\(UUID().uuidString).log")

    init(mode: String = "ok") {
        setenv("FAKE_OMP_LOG", log.path, 1)
        setenv("FAKE_OMP_MODE", mode, 1)
        unsetenv("FAKE_OMP_POLICY_MODE")
        setenv("SHELL", fakeShellPath, 1)
        unsetenv("FAKE_LOGIN_PATH")
    }

    var lines: [String] {
        ((try? String(contentsOf: log, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }
}

@MainActor
func until(timeout: TimeInterval = 10, _ probe: () -> Bool) async throws -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while !probe() {
        if Date() > deadline { return false }
        try await Task.sleep(for: .milliseconds(20))
    }
    return true
}

@MainActor
func settled(_ store: UsageStore) async throws {
    let done = try await until { !store.state.inFlight }
    XCTAssertTrue(done, "store settled")
}

func childPids() -> [pid_t] {
    var pids = [pid_t](repeating: 0, count: 64)
    let count = proc_listchildpids(getpid(), &pids, Int32(pids.count * MemoryLayout<pid_t>.size))
    return Array(pids.prefix(Int(max(count, 0)))).filter { $0 > 0 }
}

func isAlive(_ pid: pid_t) -> Bool {
    kill(pid, 0) == 0
}
