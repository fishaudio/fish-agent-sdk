import Foundation
import XCTest
@testable import FishAgent

/// Runs the conformance fixtures in packages/protocol/fixtures, the same files
/// the TypeScript client and the Android SDK run. See the README there for the
/// format.
///
/// The runner is strict on purpose: an unknown key or kind fails the test
/// instead of being skipped, so this file has to be updated with the fixtures.
@MainActor
final class FixturesTests: XCTestCase {
    private struct Failure: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }

    private struct Case {
        let file: String
        let json: [String: JSONValue]
        var name: String { json["name"]?.stringValue ?? "?" }
        func object(_ key: String) throws -> [String: JSONValue] {
            guard let value = json[key]?.objectValue else { throw Failure("\(file): \"\(name)\" has no object `\(key)`") }
            return value
        }
    }

    private func onlyKeys(_ value: [String: JSONValue], _ location: String, _ allowed: String...) throws {
        let unknown = Set(value.keys).subtracting(allowed)
        if !unknown.isEmpty { throw Failure("\(location): unknown key(s) \(unknown.sorted()); update this runner") }
    }

    private func check(_ condition: Bool, _ message: @autoclosure () -> String) throws {
        if !condition { throw Failure(message()) }
    }

    private func checkEqual<T: Equatable>(_ expected: T, _ actual: T, _ what: String) throws {
        if expected != actual { throw Failure("\(what) differs.\n      expected: \(expected)\n      actual:   \(actual)") }
    }

    /// Runs `body` for every case in a fixture file and reports all failing cases together.
    private func forEachCase(_ path: String, _ body: (Case) async throws -> Void) async throws {
        let url = repositoryRoot.appendingPathComponent("packages/protocol/fixtures").appendingPathComponent(path)
        let file = try JSONValue(data: Data(contentsOf: url))
        guard let top = file.objectValue else { throw Failure("\(path) is not an object") }
        try onlyKeys(top, path, "description", "cases")
        let cases = (top["cases"]?.arrayValue ?? []).compactMap { $0.objectValue }.map { Case(file: path, json: $0) }
        XCTAssertFalse(cases.isEmpty, "\(path) has no cases")
        XCTAssertEqual(Set(cases.map(\.name)).count, cases.count, "\(path): case names must be unique")
        var failures: [String] = []
        for item in cases {
            do {
                try await body(item)
            } catch {
                failures.append("  ✗ \(item.name)\n      \(error)")
            }
        }
        if !failures.isEmpty {
            XCTFail("\(path): \(failures.count) of \(cases.count) cases failed\n\(failures.joined(separator: "\n"))")
        }
    }

    /// Replaces whole-string placeholders anywhere in an expected value.
    private func fill(_ value: JSONValue) -> JSONValue {
        switch value {
        case let .string(text):
            switch text {
            case "{{client_timezone}}": return .string(testTimezone)
            case "{{sdk}}": return .string(testSDKHeader)
            default: return value
            }
        case let .array(items): return .array(items.map(fill))
        case let .object(fields): return .object(fields.mapValues(fill))
        default: return value
        }
    }

    private func checkMessage(_ message: String, _ expected: [String: JSONValue]) throws {
        if let exact = expected["message"]?.stringValue { try checkEqual(exact, message, "message") }
        if let prefix = expected["messageStartsWith"]?.stringValue {
            try check(message.hasPrefix(prefix), "message \"\(message)\" does not start with \"\(prefix)\"")
        }
        if let part = expected["messageContains"]?.stringValue {
            try check(message.contains(part), "message \"\(message)\" does not contain \"\(part)\"")
        }
    }

    // MARK: - messages/agent-events.json

    func testAgentEvents() async throws {
        try await forEachCase("messages/agent-events.json") { item in
            try onlyKeys(item.json, item.file, "name", "message", "expect")
            let harness = SessionHarness()
            try await harness.start()
            _ = harness.takeEvents()
            harness.transport.agent(.object(try item.object("message")))
            await settle()
            let seen = harness.takeEvents().map(fixtureForm)

            let expected = try item.object("expect")
            if let event = expected["event"]?.stringValue {
                try onlyKeys(expected, item.file, "event", "payload")
                try checkEqual([event], seen.map(\.name), "events")
                try checkEqual(expected["payload"] ?? .null, seen[0].payload, "payload")
            } else if let error = expected["error"] {
                try onlyKeys(expected, item.file, "error")
                try onlyKeys(error.objectValue ?? [:], item.file, "code", "stage", "recovered")
                try checkEqual(["error"], seen.map(\.name), "events")
                // A key left out of the fixture means the field is absent on the error.
                try checkEqual(error, seen[0].payload, "error")
            } else if let ignored = expected["ignored"] {
                try onlyKeys(expected, item.file, "ignored")
                try checkEqual(JSONValue.bool(true), ignored, "ignored")
                try checkEqual([String](), seen.map(\.name), "events")
                try checkEqual([JSONValue](), harness.transport.sent, "sent")
            } else if let reason = expected["endReasonAfterDisconnect"]?.stringValue {
                try onlyKeys(expected, item.file, "endReasonAfterDisconnect")
                try checkEqual([String](), seen.map(\.name), "events")
                harness.transport.state(.disconnected)
                try checkEqual(reason, harness.session.endReason?.rawValue ?? "none", "end reason")
            } else {
                throw Failure("\(item.file): \"\(item.name)\" has no expectation this runner knows")
            }
        }
    }

    // MARK: - messages/client-events.json

    func testClientEvents() async throws {
        try await forEachCase("messages/client-events.json") { item in
            try onlyKeys(item.json, item.file, "name", "call", "sent")
            let harness = SessionHarness()
            let session = try await harness.start()
            let call = try item.object("call")
            switch call["method"]?.stringValue {
            case "sendUserMessage":
                try onlyKeys(call, item.file, "method", "text", "audio")
                session.sendUserMessage(call["text"]?.stringValue ?? "", audio: call["audio"]?.boolValue ?? false)
            case "sendUserActivity":
                try onlyKeys(call, item.file, "method")
                session.sendUserActivity()
            case "interrupt":
                try onlyKeys(call, item.file, "method")
                session.interrupt()
            case "end":
                try onlyKeys(call, item.file, "method")
                try await session.end()
            case let method:
                throw Failure("\(item.file): unknown method \"\(method ?? "nil")\"; update this runner")
            }
            await settle()
            try checkEqual(item.json["sent"] ?? .null, .array(harness.transport.sent), "sent messages")
        }
    }

    // MARK: - session/request.json

    private func options(from json: [String: JSONValue], _ location: String) throws -> SessionOptions {
        try onlyKeys(
            json, location,
            "agentId", "origin", "serverUrl", "language", "timezone", "context", "overrides",
            "dynamicVariables", "endUserId", "metadata", "toolEvents"
        )
        var options = SessionOptions()
        options.origin = json["origin"]?.stringValue
        options.serverUrl = json["serverUrl"]?.stringValue.flatMap(URL.init(string:))
        options.language = json["language"]?.stringValue
        options.timezone = json["timezone"]?.stringValue
        if let context = json["context"]?.objectValue {
            try onlyKeys(context, location, "currentTime")
            options.context = SessionContextOptions(currentTime: context["currentTime"]?.boolValue)
        }
        if let overrides = json["overrides"]?.objectValue {
            try onlyKeys(overrides, location, "first_message", "first_message_prompt", "system_prompt", "voice_id", "language", "asr")
            options.overrides = SessionOverrides(
                firstMessage: overrides["first_message"]?.stringValue,
                firstMessagePrompt: overrides["first_message_prompt"]?.stringValue,
                systemPrompt: overrides["system_prompt"]?.stringValue,
                voiceId: overrides["voice_id"]?.stringValue,
                language: overrides["language"]?.stringValue,
                asrModel: overrides["asr"]?["model"]?.stringValue
            )
        }
        options.dynamicVariables = json["dynamicVariables"]?.objectValue
        options.endUserId = json["endUserId"]?.stringValue
        options.metadata = json["metadata"]?.objectValue
        options.toolEvents = json["toolEvents"]?.boolValue
        return options
    }

    func testSessionRequest() async throws {
        try await forEachCase("session/request.json") { item in
            try onlyKeys(item.json, item.file, "name", "options", "expect")
            let expected = try item.object("expect")
            try onlyKeys(expected, item.file, "url", "headers", "absentHeaders", "body")
            let optionsJSON = try item.object("options")
            let http = FakeHTTP()

            _ = try await resolver(http).resolve(
                .agentId(optionsJSON["agentId"]?.stringValue ?? ""),
                options: try options(from: optionsJSON, item.file)
            )

            try checkEqual(1, http.requests.count, "request count")
            let request = http.requests[0]
            try checkEqual(expected["url"]?.stringValue ?? "", request.url.absoluteString, "url")
            for (name, value) in expected["headers"]?.objectValue ?? [:] {
                try checkEqual(fill(value).stringValue ?? "", request.headers[name] ?? "(absent)", "header \(name)")
            }
            for name in expected["absentHeaders"]?.arrayValue ?? [] {
                try check(request.headers[name.stringValue ?? ""] == nil, "header \(name) must not be sent")
            }
            try checkEqual(fill(expected["body"] ?? .null), try JSONValue(data: request.body), "request body")
        }
    }

    // MARK: - session/errors.json

    func testSessionErrors() async throws {
        try await forEachCase("session/errors.json") { item in
            try onlyKeys(item.json, item.file, "name", "response", "options", "expect")
            let expected = try item.object("expect")
            try onlyKeys(expected, item.file, "code", "statusCode", "message", "messageStartsWith", "messageContains")
            let optionsJSON = item.json["options"]?.objectValue ?? [:]
            try onlyKeys(optionsJSON, item.file, "origin")
            let response = try item.object("response")
            let http: FakeHTTP
            if response["networkError"] != nil {
                try onlyKeys(response, item.file, "networkError")
                http = FakeHTTP(networkError: true)
            } else if let json = response["json"] {
                try onlyKeys(response, item.file, "status", "json")
                http = FakeHTTP(status: Int(response["status"]?.numberValue ?? 0), body: String(decoding: try json.encoded(), as: UTF8.self))
            } else if let text = response["text"]?.stringValue {
                try onlyKeys(response, item.file, "status", "text")
                http = FakeHTTP(status: Int(response["status"]?.numberValue ?? 0), body: text)
            } else {
                throw Failure("\(item.file): \"\(item.name)\" has no response this runner knows")
            }

            var options = SessionOptions()
            options.origin = optionsJSON["origin"]?.stringValue
            do {
                _ = try await resolver(http).resolve(.agentId("agent-1"), options: options)
                throw Failure("expected the request to fail")
            } catch let failure as FishAgentError {
                try checkEqual(expected["code"]?.stringValue ?? "", failure.code.rawValue, "code")
                let status: Int? = expected["statusCode"]?.numberValue.map { Int($0) }
                try checkEqual(status, failure.statusCode, "status code")
                try checkMessage(failure.message, expected)
            }
        }
    }

    // MARK: - session/tokens.json

    func testSessionTokens() async throws {
        try await forEachCase("session/tokens.json") { item in
            try onlyKeys(item.json, item.file, "name", "token", "expiresAtOffsetMs", "expect")
            let expected = try item.object("expect")
            try onlyKeys(expected, item.file, "ok", "error", "messageContains")
            var tokenJSON = try item.object("token")
            if let offset = item.json["expiresAtOffsetMs"]?.numberValue {
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                tokenJSON["expires_at"] = .string(formatter.string(from: Date(timeIntervalSince1970: (Double(nowMs) + offset) / 1000)))
            }
            // Through the same entry point an app uses for its backend's response.
            let token = try SessionToken(json: try JSONValue.object(tokenJSON).encoded())

            let outcome: Result<SessionToken, Error>
            do {
                outcome = .success(try await resolver().resolve(.sessionToken(token), options: SessionOptions()))
            } catch {
                outcome = .failure(error)
            }

            if let ok = expected["ok"] {
                try onlyKeys(expected, item.file, "ok")
                try checkEqual(JSONValue.bool(true), ok, "ok")
                guard case let .success(accepted) = outcome else { throw Failure("expected the token to be accepted, got \(outcome)") }
                try checkEqual(token.sessionId, accepted.sessionId, "session id")
            } else if let code = expected["error"]?.stringValue {
                guard case let .failure(error) = outcome, let failure = error as? FishAgentError else {
                    throw Failure("expected a FishAgentError, got \(outcome)")
                }
                try checkEqual(code, failure.code.rawValue, "code")
                try checkMessage(failure.message, expected)
            } else {
                throw Failure("\(item.file): \"\(item.name)\" has no expectation this runner knows")
            }
        }
    }

    // MARK: - tools/timeouts.json

    func testToolTimeouts() async throws {
        try await forEachCase("tools/timeouts.json") { item in
            try onlyKeys(item.json, item.file, "name", "call", "fallbackMs", "expectMs")
            let extra = try item.object("call")
            try onlyKeys(extra, item.file, "timeoutMs")
            let expectMs = Int(item.json["expectMs"]?.numberValue ?? 0)
            let harness = SessionHarness()
            var options = SessionOptions()
            options.clientTools = ["slow_tool": { _, _ in try await Task.sleep(nanoseconds: 3_600_000_000_000); return nil }]
            options.clientToolTimeout = (item.json["fallbackMs"]?.numberValue ?? 0) / 1000
            try await harness.start(options)
            var call: [String: JSONValue] = [
                "type": "client_tool.call", "callId": "call-timeout", "toolName": "slow_tool", "params": [:], "expectsResponse": true,
            ]
            call.merge(extra) { _, new in new }
            harness.transport.agent(.object(call))

            await harness.scheduler.advance(by: expectMs - 1)
            try checkEqual([JSONValue](), harness.transport.toolResults, "answered before the timeout")
            await harness.scheduler.advance(by: 1)
            try checkEqual(1, harness.transport.toolResults.count, "replies at the timeout")
            try checkEqual("call-timeout", harness.transport.toolResults[0]["callId"]?.stringValue ?? "", "call id")
            try checkEqual(true, harness.transport.toolResults[0]["isError"]?.boolValue ?? false, "isError")
        }
    }

    // MARK: - tools/results.json

    /// Longer than any timeout a fixture uses, so a tool that hangs has timed out by then.
    private let pastEveryTimeoutMs = 20000

    private func handler(for json: [String: JSONValue], _ location: String) throws -> ClientToolHandler? {
        switch json["kind"]?.stringValue {
        case "returns":
            try onlyKeys(json, location, "kind", "value")
            let value = json["value"] ?? .null
            return { _, _ in value }
        case "returnsNothing":
            try onlyKeys(json, location, "kind")
            return { _, _ in nil }
        case "returnsStringOfLength":
            try onlyKeys(json, location, "kind", "length")
            let text = String(repeating: "a", count: Int(json["length"]?.numberValue ?? 0))
            return { _, _ in .string(text) }
        case "echoesParams":
            try onlyKeys(json, location, "kind")
            return { params, _ in .object(params) }
        case "echoesContext":
            try onlyKeys(json, location, "kind")
            return { _, context in ["callId": .string(context.callId), "toolName": .string(context.toolName)] }
        case "throws":
            try onlyKeys(json, location, "kind", "message")
            let message = json["message"]?.stringValue ?? ""
            return { _, _ in throw TestError(message) }
        case "hangs":
            try onlyKeys(json, location, "kind")
            return { _, _ in try await Task.sleep(nanoseconds: 3_600_000_000_000); return nil }
        case "unregistered":
            try onlyKeys(json, location, "kind")
            return nil
        case let kind:
            throw Failure("\(location): unknown handler kind \"\(kind ?? "nil")\"; update this runner")
        }
    }

    func testToolResults() async throws {
        try await forEachCase("tools/results.json") { item in
            try onlyKeys(item.json, item.file, "name", "call", "handler", "expect")
            let expected = try item.object("expect")
            try onlyKeys(expected, item.file, "reply", "result", "resultAbsent", "errorCode")
            let call = try item.object("call")
            var options = SessionOptions()
            if let handler = try handler(for: try item.object("handler"), item.file) {
                options.clientTools = [call["toolName"]?.stringValue ?? "": handler]
            }
            let harness = SessionHarness()
            try await harness.start(options)
            _ = harness.takeEvents()

            harness.transport.agent(.object(call))
            await settle()
            await harness.scheduler.advance(by: pastEveryTimeoutMs)

            let errorCodes: [String] = harness.takeEvents().compactMap {
                if case let .error(error) = $0 { return error.code.rawValue }
                return nil
            }
            try checkEqual(expected["errorCode"]?.stringValue.map { [$0] } ?? [], errorCodes, "error codes")

            let replies = harness.transport.toolResults
            switch expected["reply"]?.stringValue {
            case "none":
                try onlyKeys(expected, item.file, "reply", "errorCode")
                try checkEqual([JSONValue](), replies, "replies")
            case "result":
                try checkEqual(1, replies.count, "reply count")
                let reply = replies[0]
                try checkEqual(call["callId"] ?? .null, reply["callId"] ?? .null, "call id")
                try check(reply["isError"] == nil, "a result must not carry isError")
                if let absent = expected["resultAbsent"] {
                    try checkEqual(JSONValue.bool(true), absent, "resultAbsent")
                    try check(reply["result"] == nil, "there must be no result field")
                } else if let result = expected["result"] {
                    try checkEqual(result, reply["result"] ?? .null, "result")
                } else {
                    try check(reply["result"] != nil, "there must be a result field")
                }
            case "error":
                try onlyKeys(expected, item.file, "reply", "result", "errorCode")
                try checkEqual(1, replies.count, "reply count")
                let reply = replies[0]
                try checkEqual(call["callId"] ?? .null, reply["callId"] ?? .null, "call id")
                try checkEqual(JSONValue.bool(true), reply["isError"] ?? .null, "isError")
                if let result = expected["result"] {
                    try checkEqual(result, reply["result"] ?? .null, "result")
                } else {
                    try check(reply["result"]?.stringValue != nil, "an error result carries text")
                }
            case let kind:
                throw Failure("\(item.file): unknown reply \"\(kind ?? "nil")\"; update this runner")
            }
        }
    }

    // MARK: - scenarios/session.json

    func testSessionScenarios() async throws {
        try await forEachCase("scenarios/session.json") { item in
            try onlyKeys(item.json, item.file, "name", "start", "steps")
            let start = item.json["start"]?.objectValue ?? [:]
            try onlyKeys(start, item.file, "agent")
            let harness = SessionHarness()
            let session = try await harness.start(agentReady: false)
            switch start["agent"]?.stringValue ?? "ready" {
            case "ready":
                harness.transport.agentState("initializing")
                harness.transport.ready()
            case "joined": harness.transport.agentState("initializing")
            case "absent": break
            case let agent: throw Failure("\(item.file): unknown start.agent \"\(agent)\"; update this runner")
            }
            await settle()
            var sentChecked = 0

            for (index, element) in (item.json["steps"]?.arrayValue ?? []).enumerated() {
                let step = element.objectValue ?? [:]
                let location = "\(item.file): \"\(item.name)\" step \(index + 1)"
                if let action = step["do"]?.stringValue {
                    switch action {
                    case "agentState":
                        try onlyKeys(step, location, "do", "state")
                        harness.transport.agentState(step["state"]?.stringValue ?? "")
                    case "agentReady":
                        try onlyKeys(step, location, "do")
                        harness.transport.ready()
                    case "agentEvent":
                        try onlyKeys(step, location, "do", "message")
                        harness.transport.agent(step["message"] ?? .null)
                    case "transcription":
                        try onlyKeys(step, location, "do", "role", "segmentId", "text", "final")
                        guard let role = step["role"]?.stringValue.flatMap(MessageRole.init(rawValue:)) else {
                            throw Failure("\(location): unknown role")
                        }
                        harness.transport.transcription(
                            step["segmentId"]?.stringValue ?? "", role, step["text"]?.stringValue ?? "",
                            isFinal: step["final"]?.boolValue ?? false
                        )
                    case "connectionState":
                        try onlyKeys(step, location, "do", "state", "reason")
                        let state: TransportConnectionState
                        switch step["state"]?.stringValue {
                        case "connected": state = .connected
                        case "reconnecting": state = .reconnecting
                        case "disconnected": state = .disconnected
                        case let other: throw Failure("\(location): unknown state \"\(other ?? "nil")\"")
                        }
                        harness.transport.state(state, reason: step["reason"]?.stringValue)
                    case "sendUserMessage":
                        try onlyKeys(step, location, "do", "text", "audio")
                        session.sendUserMessage(step["text"]?.stringValue ?? "", audio: step["audio"]?.boolValue ?? false)
                    case "sendUserActivity":
                        try onlyKeys(step, location, "do")
                        session.sendUserActivity()
                    case "interrupt":
                        try onlyKeys(step, location, "do")
                        session.interrupt()
                    case "end":
                        try onlyKeys(step, location, "do")
                        try await session.end()
                    case "advance":
                        try onlyKeys(step, location, "do", "ms")
                        await harness.scheduler.advance(by: Int(step["ms"]?.numberValue ?? 0))
                    default:
                        throw Failure("\(location): unknown action \"\(action)\"; update this runner")
                    }
                    await settle()
                } else if let expectation = step["expect"]?.stringValue {
                    switch expectation {
                    case "sent":
                        try onlyKeys(step, location, "expect", "messages")
                        let since = Array(harness.transport.sent.dropFirst(sentChecked))
                        sentChecked = harness.transport.sent.count
                        try checkEqual(step["messages"] ?? .null, .array(since), "\(location): sent messages")
                    case "events":
                        try onlyKeys(step, location, "expect", "of", "events")
                        let since = harness.takeEvents().map(fixtureForm)
                        if step["events"]?.stringValue == "any" {
                            try onlyKeys(step, location, "expect", "events")
                        } else {
                            let of = step["of"]?.arrayValue?.compactMap(\.stringValue)
                            let relevant = of.map { names in since.filter { names.contains($0.name) } } ?? since
                            let actual = JSONValue.array(relevant.map { ["event": .string($0.name), "payload": $0.payload] })
                            try checkEqual(step["events"] ?? .null, actual, "\(location): events")
                        }
                    case "state":
                        try onlyKeys(step, location, "expect", "status", "mode", "endReason")
                        if let status = step["status"]?.stringValue { try checkEqual(status, session.status.rawValue, "\(location): status") }
                        if let mode = step["mode"]?.stringValue { try checkEqual(mode, session.mode.rawValue, "\(location): mode") }
                        if let reason = step["endReason"] {
                            try checkEqual(reason.stringValue, session.endReason?.rawValue, "\(location): end reason")
                        }
                    default:
                        throw Failure("\(location): unknown expectation \"\(expectation)\"; update this runner")
                    }
                } else {
                    throw Failure("\(location): a step needs \"do\" or \"expect\"")
                }
            }
        }
    }
}
