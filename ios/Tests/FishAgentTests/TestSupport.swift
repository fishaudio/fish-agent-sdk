import Foundation
import XCTest
@testable import FishAgent

let nowMs: Int64 = 1_795_000_000_000
let testSDKHeader = "agent-ios/test"
let testTimezone = "Asia/Tokyo"

func validToken() -> SessionToken {
    SessionToken(
        transport: "livekit",
        sessionId: "sess-1",
        expiresAt: "2099-01-01T00:00:00Z",
        maxDurationSeconds: 600,
        livekitUrl: "wss://example.livekit.cloud",
        token: "tok"
    )
}

struct TestError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Lets everything that is ready to run on the main actor run, including tool
/// handlers, which hop off the main actor and back.
@MainActor
func settle() async {
    for _ in 0 ..< 4 {
        for _ in 0 ..< 10 { await Task.yield() }
        try? await Task.sleep(nanoseconds: 500_000)
    }
    for _ in 0 ..< 10 { await Task.yield() }
}

/// Time moved by hand.
@MainActor
final class ManualScheduler: Scheduler {
    private final class Work: ScheduledWork {
        let due: Int
        let order: Int
        let action: @MainActor () -> Void
        var cancelled = false
        init(due: Int, order: Int, action: @escaping @MainActor () -> Void) {
            self.due = due
            self.order = order
            self.action = action
        }

        func cancel() { cancelled = true }
    }

    private(set) var now = 0
    private var pending: [Work] = []
    private var counter = 0

    func schedule(afterMilliseconds milliseconds: Int, _ action: @escaping @MainActor () -> Void) -> ScheduledWork {
        counter += 1
        let work = Work(due: now + max(0, milliseconds), order: counter, action: action)
        pending.append(work)
        return work
    }

    /// Moves time forward. Timers due at exactly the new time fire.
    func advance(by milliseconds: Int) async {
        let target = now + milliseconds
        while let next = pending.filter({ !$0.cancelled && $0.due <= target }).min(by: { ($0.due, $0.order) < ($1.due, $1.order) }) {
            pending.removeAll { $0 === next }
            now = max(now, next.due)
            next.action()
            await settle()
        }
        pending.removeAll { $0.cancelled }
        now = target
        await settle()
    }
}

/// A transport the test drives by hand.
@MainActor
final class FakeTransport: Transport {
    weak var delegate: TransportDelegate?
    /// Kept so the delegate (the session) is not released while a test still drives the transport.
    private var strongDelegate: TransportDelegate?
    var connectedWithMicrophone: Bool?
    var sent: [JSONValue] = []
    var micEnabled = true
    var connectError: Error?
    var micError: Error?
    var disconnectError: Error?
    var disconnectCalls = 0
    /// When set, `connect` waits until it is resumed.
    var connectGate: CheckedContinuation<Void, Never>?
    var holdConnect = false
    /// When set, `disconnect` waits until it is resumed.
    var holdDisconnect = false
    var disconnectGate: CheckedContinuation<Void, Never>?
    /// Fails the next `sendFailures` sends, then delivers normally.
    var sendFailures = 0

    func connect(sessionToken: SessionToken, delegate: TransportDelegate, microphone: Bool) async throws {
        self.delegate = delegate
        strongDelegate = delegate
        connectedWithMicrophone = microphone
        if holdConnect {
            await withCheckedContinuation { connectGate = $0 }
        }
        if let connectError { throw connectError }
    }

    func releaseConnect() {
        holdConnect = false
        connectGate?.resume()
        connectGate = nil
    }

    func disconnect() async throws {
        disconnectCalls += 1
        if holdDisconnect {
            await withCheckedContinuation { disconnectGate = $0 }
        }
        if let disconnectError { throw disconnectError }
    }

    func releaseDisconnect() {
        holdDisconnect = false
        disconnectGate?.resume()
        disconnectGate = nil
    }

    func setMicEnabled(_ enabled: Bool) async throws {
        if let micError { throw micError }
        micEnabled = enabled
    }

    func sendClientEvent(_ message: JSONValue) async throws {
        if sendFailures > 0 {
            sendFailures -= 1
            throw TestError("send failed")
        }
        sent.append(message)
    }

    func agent(_ message: JSONValue) { delegate?.transportDidReceiveAgentEvent(message) }
    func agentState(_ state: String) { delegate?.transportDidSeeAgentState(state) }
    func ready() { delegate?.transportDidSeeAgentReady() }
    func state(_ state: TransportConnectionState, reason: String? = nil) {
        delegate?.transportDidChangeConnectionState(state, reason: reason)
    }

    func transcription(_ segmentId: String, _ role: MessageRole, _ text: String, isFinal: Bool) {
        delegate?.transportDidReceiveTranscription(
            TranscriptionSegmentUpdate(segmentId: segmentId, role: role, text: text, isFinal: isFinal)
        )
    }

    var toolResults: [JSONValue] { sent.filter { $0["type"]?.stringValue == "client_tool.result" } }
}

struct CapturedRequest: Sendable {
    let url: URL
    let headers: [String: String]
    let body: Data
}

/// Answers the session request with a fixed response, or fails like a dead network.
final class FakeHTTP: HTTPClient, @unchecked Sendable {
    private let status: Int
    private let body: Data
    private let networkError: Bool
    private let lock = NSLock()
    private var captured: [CapturedRequest] = []

    init(
        status: Int = 201,
        body: String = #"{"transport":"livekit","session_id":"sess-http","livekit_url":"wss://x","token":"t"}"#,
        networkError: Bool = false
    ) {
        self.status = status
        self.body = Data(body.utf8)
        self.networkError = networkError
    }

    var requests: [CapturedRequest] {
        lock.withLock { captured }
    }

    func post(url: URL, headers: [String: String], body: Data) async throws -> HTTPResponse {
        lock.withLock { captured.append(CapturedRequest(url: url, headers: headers, body: body)) }
        if networkError { throw URLError(.cannotConnectToHost) }
        return HTTPResponse(status: status, body: self.body)
    }
}

func resolver(_ http: any HTTPClient = FakeHTTP()) -> SessionTokenResolver {
    SessionTokenResolver(http: http, now: { nowMs }, clientTimezone: { testTimezone }, sdkHeader: testSDKHeader)
}

/// A session wired to a `FakeTransport`, with its events collected.
@MainActor
final class SessionHarness {
    let transport = FakeTransport()
    let scheduler = ManualScheduler()
    var events: [ConversationEvent] = []
    var session: AgentSession!

    var dependencies: SessionDependencies {
        SessionDependencies(
            makeTransport: { [transport] in transport },
            tokens: resolver(),
            scheduler: scheduler,
            onEvent: { [weak self] event in self?.events.append(event) }
        )
    }

    /// Starts a session. With `agentReady`, the agent joins and announces it is ready, as a current runtime does.
    @discardableResult
    func start(
        _ options: SessionOptions = SessionOptions(),
        auth: SessionAuth = .sessionToken(validToken()),
        agentReady: Bool = true
    ) async throws -> AgentSession {
        session = try await AgentSession.start(auth, options: options, dependencies: dependencies)
        if agentReady {
            transport.agentState("initializing")
            transport.ready()
        }
        await settle()
        return session
    }

    /// Events seen since the last call.
    func takeEvents() -> [ConversationEvent] {
        defer { events = [] }
        return events
    }
}

/// An event in the shape the shared fixtures use: the TypeScript event name and its payload.
func fixtureForm(_ event: ConversationEvent) -> (name: String, payload: JSONValue) {
    switch event {
    case let .connect(sessionId): return ("connect", ["sessionId": .string(sessionId)])
    case let .disconnect(reason): return ("disconnect", ["reason": .string(reason.rawValue)])
    case let .statusChange(status): return ("statusChange", .string(status.rawValue))
    case let .modeChange(mode): return ("modeChange", .string(mode.rawValue))
    case let .userTranscript(segmentId, text, isFinal):
        return ("userTranscript", ["segmentId": .string(segmentId), "text": .string(text), "final": .bool(isFinal)])
    case let .agentResponseDelta(segmentId, delta, text):
        return ("agentResponseDelta", ["segmentId": .string(segmentId), "delta": .string(delta), "text": .string(text)])
    case let .agentResponse(segmentId, text):
        return ("agentResponse", ["segmentId": .string(segmentId), "text": .string(text)])
    case let .message(role, text): return ("message", ["role": .string(role.rawValue), "text": .string(text)])
    case let .toolCallStarted(event):
        return ("toolCallStarted", [
            "callId": .string(event.callId), "toolName": .string(event.toolName), "source": .string(event.source.rawValue),
            "input": .string(event.input), "inputTruncated": .bool(event.inputTruncated),
        ])
    case let .toolCallCompleted(event):
        return ("toolCallCompleted", [
            "callId": .string(event.callId), "toolName": .string(event.toolName), "source": .string(event.source.rawValue),
            "output": .string(event.output), "outputTruncated": .bool(event.outputTruncated),
        ])
    case let .toolCallFailed(event):
        var payload: [String: JSONValue] = [
            "callId": .string(event.callId), "toolName": .string(event.toolName), "source": .string(event.source.rawValue),
            "error": .string(event.error),
        ]
        if let status = event.httpStatus { payload["httpStatus"] = .number(Double(status)) }
        return ("toolCallFailed", .object(payload))
    case let .error(error):
        var payload: [String: JSONValue] = ["code": .string(error.code.rawValue)]
        if let stage = error.stage { payload["stage"] = .string(stage.rawValue) }
        if let recovered = error.recovered { payload["recovered"] = .bool(recovered) }
        return ("error", .object(payload))
    }
}

/// The repository root, found from this file's own path.
let repositoryRoot: URL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent() // FishAgentTests
    .deletingLastPathComponent() // Tests
    .deletingLastPathComponent() // ios
    .deletingLastPathComponent()
