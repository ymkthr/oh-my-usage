import Foundation

/// GUI apps do not inherit the login shell's PATH, so a PATH lookup would miss omp.
func defaultOmpPath() -> String {
    URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".bun/bin/omp").path
}

/// The markers keep rc-file greetings around the value out of it.
private let loginPathScript = #"printf "\n__OMU__%s__OMU__\n" "$PATH""#

private func markedValue(_ stdout: String) -> String? {
    let parts = stdout.components(separatedBy: "__OMU__")
    return parts.count >= 3 && !parts[1].isEmpty ? parts[1] : nil
}

enum Request {
    case read, invalidate

    static func merge(_ queued: Request?, _ incoming: Request) -> Request {
        queued == .invalidate || incoming == .invalidate ? .invalidate : .read
    }
}

/// Mirrors src/store.js: one drain loop at a time, refreshes during it merge
/// into a single follow-up, and nothing is published after destroy().
@MainActor
final class UsageStore {
    private struct Cancelled: Error {}

    private struct Completed {
        let status: Int32
        let stdout: String
        let stderr: String
    }

    private(set) var state: StoreState
    var onChange: @MainActor () -> Void = {}

    private let script: ModelScript
    private let watchdogSeconds: TimeInterval
    private var ompPath = defaultOmpPath()
    private var intervalSeconds = 0
    private var queued: Request?
    private var child: Process?
    private var timer: Timer?
    private var destroyed = false
    /// omp is usually a `#!/usr/bin/env bun` script, and bun is rarely on the
    /// GUI PATH, so children run under the login shell's PATH, read once.
    private var childPath: String?

    init(script: ModelScript, ompPath: String, intervalSeconds: Int, watchdogSeconds: TimeInterval = 60) {
        self.script = script
        self.watchdogSeconds = watchdogSeconds
        state = StoreState(snapshot: nil, policies: script.emptyPolicies(), error: nil, inFlight: false)
        configure(ompPath: ompPath, intervalSeconds: intervalSeconds)
    }

    func configure(ompPath: String, intervalSeconds: Int) {
        self.ompPath = ompPath.isEmpty ? defaultOmpPath() : ompPath
        self.intervalSeconds = intervalSeconds
        armTimer()
    }

    func refresh(_ request: Request = .read) {
        guard !destroyed else { return }
        if state.inFlight {
            queued = .merge(queued, request)
            return
        }
        state.inFlight = true
        onChange()
        Task { await drain(request) }
    }

    func destroy() {
        guard !destroyed else { return }
        destroyed = true
        if let child, child.isRunning {
            kill(child.processIdentifier, SIGKILL)
        }
        timer?.invalidate()
        timer = nil
        queued = nil
    }

    private func armTimer() {
        timer?.invalidate()
        timer = nil
        guard intervalSeconds > 0, !destroyed else { return }
        let timer = Timer(timeInterval: TimeInterval(intervalSeconds), repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.refresh(.read) }
        }
        // .common keeps the timer firing while the status menu is tracking.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    private func drain(_ first: Request) async {
        var next: Request? = first
        while let request = next, !destroyed {
            await runOnce(request)
            next = queued
            queued = nil
        }
        state.inFlight = false
        if !destroyed {
            onChange()
        }
    }

    private func runOnce(_ request: Request) async {
        let path = ompPath
        guard FileManager.default.isExecutableFile(atPath: path) else {
            state.error = .missingBinary(path: path)
            return
        }

        let environment = await childEnvironment()
        do {
            if request == .invalidate {
                _ = try await spawn(path, ["usage", "invalidate"], environment: environment)
            }
            let run = try await spawn(path, ["usage", "--json"], environment: environment)
            guard run.status == 0 else {
                state.error = .exit(status: run.status, stderrHead: firstLine(run.stderr))
                return
            }
            state.snapshot = try script.parseUsage(run.stdout)
            state.error = nil
            await readPolicies(path, environment: environment)
        } catch let error as FetchError {
            state.error = error
        } catch {
            // Only Cancelled lands here, and destroy() leaves the state untouched.
        }
    }

    /// Priorities only order the accounts, so an omp that cannot answer the
    /// config read keeps the last policies instead of failing the refresh.
    private func readPolicies(_ path: String, environment: [String: String]) async {
        guard let run = try? await spawn(path, ["config", "get", "auth.accountPolicies", "--json"], environment: environment),
              run.status == 0,
              let policies = script.parsePolicies(run.stdout)
        else { return }
        state.policies = policies
    }

    /// `-i` as well as `-l`, because PATH additions often live in the interactive rc file.
    private func childEnvironment() async -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        if childPath == nil {
            let shell = environment["SHELL"] ?? "/bin/sh"
            let run = try? await spawn(shell, ["-l", "-i", "-c", loginPathScript], environment: environment)
            childPath = run.flatMap { markedValue($0.stdout) } ?? environment["PATH"]
        }
        environment["PATH"] = childPath
        return environment
    }

    private func spawn(_ path: String, _ arguments: [String], environment: [String: String]) async throws -> Completed {
        guard !destroyed else { throw Cancelled() }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        // Set before run(): a handler assigned after a fast exit would never fire.
        let (exits, exited) = AsyncStream.makeStream(of: Int32.self)
        process.terminationHandler = { process in
            let signaled = process.terminationReason == .uncaughtSignal
            exited.yield(signaled ? 128 + process.terminationStatus : process.terminationStatus)
            exited.finish()
        }

        do {
            try process.run()
        } catch {
            throw launchError(error, path: path)
        }
        child = process
        let watchdog = Timer(timeInterval: watchdogSeconds, repeats: false) { _ in
            if process.isRunning {
                kill(process.processIdentifier, SIGKILL)
            }
        }
        RunLoop.main.add(watchdog, forMode: .common)
        defer {
            watchdog.invalidate()
            child = nil
        }

        // Both pipes drain concurrently with the wait, so a chatty child never
        // blocks on a full pipe buffer.
        async let out = readToEnd(stdout.fileHandleForReading)
        async let err = readToEnd(stderr.fileHandleForReading)
        var status: Int32 = -1
        for await code in exits {
            status = code
        }
        let completed = Completed(
            status: status,
            stdout: String(decoding: await out, as: UTF8.self),
            stderr: String(decoding: await err, as: UTF8.self))
        guard !destroyed else { throw Cancelled() }
        return completed
    }
}

private func readToEnd(_ handle: FileHandle) async -> Data {
    await withCheckedContinuation { continuation in
        DispatchQueue.global().async {
            continuation.resume(returning: (try? handle.readToEnd()) ?? Data())
        }
    }
}

private func launchError(_ error: any Error, path: String) -> FetchError {
    let error = error as NSError
    let missing = (error.domain == NSCocoaErrorDomain && error.code == NSFileNoSuchFileError)
        || (error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT))
    return missing ? .missingBinary(path: path) : .spawn(path: path, detail: error.localizedDescription)
}

private func firstLine(_ text: String) -> String {
    text.components(separatedBy: "\n")
        .lazy
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .first { !$0.isEmpty } ?? ""
}
