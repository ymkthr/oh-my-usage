import Foundation
import JavaScriptCore

enum Level: String, Decodable {
    case normal, warning, error
}

struct BarView: Decodable {
    let fraction: Double
    let level: Level
}

struct PanelView: Decodable {
    struct Alert: Decodable {
        let text: String
        let level: Level
    }

    let bars: [BarView]
    let text: String
    let level: Level
    let stale: Bool
    let alert: Alert?
}

struct RowView: Decodable {
    let label: String
    let fraction: Double
    let level: Level
    let detail: String
}

struct SectionView: Decodable {
    let key: String
    let title: String
    let subtitle: String
    let badge: String?
    let primary: Bool
    let rows: [RowView]
}

struct ProviderView: Decodable {
    let provider: String
    let title: String
    let count: String
    let accounts: [SectionView]
}

struct AlertView: Decodable {
    let key: String
    let title: String
    let label: String
    let detail: String
    let level: Level
}

struct View: Decodable {
    let panel: PanelView
    let status: String
    let statusLevel: Level
    let notice: String?
    let providers: [ProviderView]
    let alerts: [AlertView]
}

enum FetchError: Error, Equatable {
    case missingBinary(path: String)
    case spawn(path: String, detail: String)
    case exit(status: Int32, stderrHead: String)
    case invalidJSON(detail: String)

    fileprivate var jsObject: [String: Any] {
        switch self {
        case .missingBinary(let path):
            ["kind": "missing-binary", "path": path]
        case .spawn(let path, let detail):
            ["kind": "spawn", "path": path, "detail": detail]
        case .exit(let status, let stderrHead):
            ["kind": "exit", "status": status, "stderrHead": stderrHead]
        case .invalidJSON(let detail):
            ["kind": "invalid-json", "detail": detail]
        }
    }
}

/// `snapshot` and `policies` stay JS values from model.js; only renderView reads them.
struct StoreState {
    var snapshot: JSValue?
    var policies: JSValue
    var error: FetchError?
    var inFlight: Bool
}

/// src/model.js running in one JSContext, so formatting, ordering, levels
/// and labels have a single owner shared with the GNOME extension.
@MainActor
final class ModelScript {
    private struct ScriptError: Error {
        let message: String
    }

    private let context: JSContext
    private let parseUsageFunction: JSValue
    private let parsePoliciesFunction: JSValue
    private let renderFunction: JSValue

    convenience init(contentsOf url: URL) throws {
        self.init(source: try String(contentsOf: url, encoding: .utf8))
    }

    init(source: String) {
        context = JSContext()
        // JSContext evaluates classic scripts, where `export` is a syntax error.
        context.evaluateScript(source.replacingOccurrences(of: #"(?m)^export "#, with: "", options: .regularExpression))
        parseUsageFunction = context.objectForKeyedSubscript("parseUsage")
        parsePoliciesFunction = context.objectForKeyedSubscript("parsePolicies")
        renderFunction = context.evaluateScript("""
            (snapshot, policies, error, inFlight, primaryAccount, now) =>
                JSON.stringify(renderView({snapshot, policies, error, inFlight}, {primaryAccount}, now))
            """)
    }

    func emptyPolicies() -> JSValue {
        JSValue(newArrayIn: context)
    }

    func parseUsage(_ stdout: String) throws(FetchError) -> JSValue {
        do {
            return try call(parseUsageFunction, [stdout])
        } catch {
            throw .invalidJSON(detail: error.message)
        }
    }

    func parsePolicies(_ stdout: String) -> JSValue? {
        try? call(parsePoliciesFunction, [stdout])
    }

    func render(_ state: StoreState, primaryAccount: String, now: Date) -> View {
        let arguments: [Any] = [
            state.snapshot ?? NSNull(),
            state.policies,
            state.error?.jsObject ?? NSNull(),
            state.inFlight,
            primaryAccount,
            (now.timeIntervalSince1970 * 1000).rounded(),
        ]
        do {
            let json = try call(renderFunction, arguments).toString() ?? ""
            return try JSONDecoder().decode(View.self, from: Data(json.utf8))
        } catch {
            preconditionFailure("model.js renderView broke the View contract: \(error)")
        }
    }

    private func call(_ function: JSValue, _ arguments: [Any]) throws(ScriptError) -> JSValue {
        context.exception = nil
        let result = function.call(withArguments: arguments)
        if let exception = context.exception {
            context.exception = nil
            let message = exception.forProperty("message")
            throw ScriptError(message: (message?.isUndefined == false ? message : exception)?.toString() ?? "")
        }
        guard let result else {
            throw ScriptError(message: "no result")
        }
        return result
    }
}
