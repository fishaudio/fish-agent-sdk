import Foundation
import XCTest
@testable import FishAgent

/// Behaviour the shared fixtures cannot express: failures while starting,
/// concurrent hangups, and tool replies that cannot be sent. Test names follow
/// packages/client/src/__tests__/agentSession.test.ts where a test there has a
/// counterpart here.
@MainActor
final class AgentSessionTests: XCTestCase {
    private func toolCall(_ toolName: String, callId: String = "call-1", expectsResponse: Bool = true, timeoutMs: Int? = nil) -> JSONValue {
        var call: [String: JSONValue] = [
            "type": "client_tool.call", "callId": .string(callId), "toolName": .string(toolName), "params": [:],
            "expectsResponse": .bool(expectsResponse),
        ]
        if let timeoutMs { call["timeoutMs"] = .number(Double(timeoutMs)) }
        return .object(call)
    }

    private func failure(_ body: () async throws -> Void) async -> Error? {
        do {
            try await body()
            return nil
        } catch {
            return error
        }
    }

    private func names(_ events: [ConversationEvent]) -> [String] { events.map { fixtureForm($0).name } }

    private func errorCodes(_ events: [ConversationEvent]) -> [FishAgentError.Code] {
        events.compactMap {
            if case let .error(error) = $0 { return error.code }
            return nil
        }
    }

    // MARK: - Starting

    func testConnectsAndReportsTheSessionId() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        XCTAssertEqual(session.status, .connected)
        XCTAssertEqual(session.sessionId, "sess-1")
        XCTAssertEqual(names(harness.takeEvents()), ["statusChange", "connect"])
    }

    func testRejectsASessionTokenWithAnUnknownTransportBeforeConnecting() async {
        let harness = SessionHarness()
        let token = SessionToken(transport: "carrier-pigeon", sessionId: "sess-1")
        let error = await failure { try await harness.start(auth: .sessionToken(token)) } as? FishAgentError
        XCTAssertEqual(error?.code, .unsupportedTransport)
        XCTAssertNil(harness.transport.connectedWithMicrophone, "the transport must not be touched")
        XCTAssertTrue(harness.events.isEmpty)
    }

    func testDisconnectsAPartiallyConnectedSessionAndKeepsAMicrophoneError() async {
        let harness = SessionHarness()
        harness.transport.connectError = FishAgentError(.micPermissionDenied, "denied")
        let error = await failure { try await harness.start() } as? FishAgentError
        XCTAssertEqual(error?.code, .micPermissionDenied)
        XCTAssertEqual(harness.transport.disconnectCalls, 1)
        XCTAssertEqual(names(harness.events), ["statusChange", "disconnect"])
        if case let .disconnect(reason)? = harness.events.last { XCTAssertEqual(reason, .connectionLost) } else { XCTFail("no disconnect") }
    }

    func testWrapsAnyOtherConnectFailureAsConnectionFailed() async {
        let harness = SessionHarness()
        harness.transport.connectError = TestError("ice failed")
        let error = await failure { try await harness.start() } as? FishAgentError
        XCTAssertEqual(error?.code, .connectionFailed)
        XCTAssertEqual((error?.underlyingError as? TestError)?.description, "ice failed")
    }

    func testAStartWithoutTheMicrophoneBeginsMutedAndTellsTheTransport() async throws {
        let harness = SessionHarness()
        var options = SessionOptions()
        options.microphone = false
        let session = try await harness.start(options)
        XCTAssertTrue(session.micMuted)
        XCTAssertEqual(harness.transport.connectedWithMicrophone, false)
    }

    func testAPublicAgentStartCreatesTheSessionOverHTTP() async throws {
        let http = FakeHTTP()
        let transport = FakeTransport()
        let session = try await AgentSession.start(
            .agentId("agent-1"),
            options: SessionOptions(),
            dependencies: SessionDependencies(makeTransport: { transport }, tokens: resolver(http), scheduler: ManualScheduler(), onEvent: { _ in })
        )
        XCTAssertEqual(session.sessionId, "sess-http")
        XCTAssertEqual(http.requests.first?.url.absoluteString, "https://api.fish.audio/v1/agent/sessions")
    }

    // MARK: - Ending

    func testConcurrentEndCallsShareOneHangup() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        harness.transport.holdDisconnect = true
        let first = Task { try await session.end() }
        let second = Task { try await session.end() }
        await settle()
        XCTAssertEqual(harness.transport.disconnectCalls, 1)
        XCTAssertEqual(session.status, .connected)
        harness.transport.releaseDisconnect()
        try await first.value
        try await second.value
        XCTAssertEqual(harness.transport.disconnectCalls, 1)
        XCTAssertEqual(session.endReason, .userHangup)
        XCTAssertEqual(names(harness.events).filter { $0 == "disconnect" }.count, 1)
    }

    func testEndAfterTheSessionEndedDoesNothing() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        harness.transport.state(.disconnected, reason: DisconnectReasons.roomDeleted)
        try await session.end()
        XCTAssertEqual(harness.transport.disconnectCalls, 0)
        XCTAssertEqual(session.endReason, .agentHangup)
    }

    func testAFailedTeardownCanBeRetried() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        harness.transport.disconnectError = TestError("still closing")
        let error = await failure { try await session.end() }
        XCTAssertTrue(error is TestError)
        XCTAssertEqual(session.status, .connected)
        harness.transport.disconnectError = nil
        try await session.end()
        XCTAssertEqual(session.endReason, .userHangup)
        XCTAssertEqual(harness.transport.disconnectCalls, 2)
    }

    func testHangsUpEvenWhenTheHangupMessageCannotBeSent() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        harness.transport.sendFailures = 1
        try await session.end()
        XCTAssertEqual(session.endReason, .userHangup)
        XCTAssertEqual(harness.transport.disconnectCalls, 1)
    }

    // MARK: - Microphone

    func testRollsTheMutedStateBackWhenTheMicrophoneCannotBeToggled() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        harness.transport.micError = TestError("no device")
        let error = await failure { try await session.setMicMuted(true) } as? FishAgentError
        XCTAssertEqual(error?.code, .connectionFailed)
        XCTAssertFalse(session.micMuted)

        harness.transport.micError = nil
        try await session.setMicMuted(true)
        XCTAssertTrue(session.micMuted)
        XCTAssertFalse(harness.transport.micEnabled)
    }

    // MARK: - Sending

    func testReportsAMessageThatCouldNotBeSentAsAnErrorEvent() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        _ = harness.takeEvents()
        harness.transport.sendFailures = 1
        session.interrupt()
        await settle()
        XCTAssertEqual(errorCodes(harness.takeEvents()), [.connectionFailed])
        XCTAssertEqual(session.status, .connected)
    }

    func testMessagesLeaveInTheOrderTheyWereSent() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        for index in 1 ... 20 { session.sendUserMessage("message \(index)") }
        session.interrupt()
        await settle()
        let texts = harness.transport.sent.compactMap { $0["text"]?.stringValue }
        XCTAssertEqual(texts, (1 ... 20).map { "message \($0)" })
        XCTAssertEqual(harness.transport.sent.last?["type"]?.stringValue, "user.interrupt")
    }

    // MARK: - Transcript

    func testKeepsTheTranscriptInConversationOrderAndRefinesSegmentsInPlace() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        harness.transport.transcription("SG_1", .agent, "Hi", isFinal: false)
        harness.transport.transcription("SG_2", .user, "where", isFinal: false)
        session.sendUserMessage("typed")
        harness.transport.transcription("SG_1", .agent, "Hi there", isFinal: true)
        harness.transport.transcription("SG_2", .user, "where is it", isFinal: true)
        XCTAssertEqual(session.getTranscript(), [
            TranscriptSegment(segmentId: "SG_1", role: .agent, text: "Hi there", isFinal: true),
            TranscriptSegment(segmentId: "SG_2", role: .user, text: "where is it", isFinal: true),
            TranscriptSegment(segmentId: "typed_1", role: .user, text: "typed", isFinal: true),
        ])
    }

    func testTheSameSegmentIdFromBothSidesStaysTwoSegments() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        harness.transport.transcription("SG_1", .agent, "agent text", isFinal: true)
        harness.transport.transcription("SG_1", .user, "user text", isFinal: true)
        XCTAssertEqual(session.getTranscript().map(\.role), [.agent, .user])
    }

    // MARK: - Client tools

    func testSupportsLateRegistrationViaRegisterClientTool() async throws {
        let harness = SessionHarness()
        let session = try await harness.start()
        session.registerClientTool("late") { _, _ in "ok" }
        harness.transport.agent(toolCall("late"))
        await settle()
        XCTAssertEqual(harness.transport.toolResults.first?["result"]?.stringValue, "ok")
    }

    func testAnswersAtTheDeadlineEvenWhenTheHandlerIgnoresCancellation() async throws {
        let harness = SessionHarness()
        var options = SessionOptions()
        let release = Gate()
        options.clientTools = ["stubborn": { _, _ in
            // Ignores cancellation: waits for the test to let it go.
            await release.wait()
            return "too late"
        }]
        try await harness.start(options)
        _ = harness.takeEvents()
        harness.transport.agent(toolCall("stubborn", timeoutMs: 2000))
        await harness.scheduler.advance(by: 1800)
        XCTAssertEqual(harness.transport.toolResults.count, 1)
        XCTAssertEqual(harness.transport.toolResults.first?["isError"]?.boolValue, true)
        XCTAssertEqual(errorCodes(harness.takeEvents()), [.toolTimeout])
        // The handler finishing later must not send a second reply.
        await release.open()
        await settle()
        XCTAssertEqual(harness.transport.toolResults.count, 1)
    }

    func testTradesAResultThatCouldNotBeDeliveredForAnErrorResult() async throws {
        let harness = SessionHarness()
        var options = SessionOptions()
        options.clientTools = ["tool": { _, _ in "value" }]
        try await harness.start(options)
        _ = harness.takeEvents()
        harness.transport.sendFailures = 1
        harness.transport.agent(toolCall("tool"))
        await settle()
        XCTAssertEqual(harness.transport.toolResults.count, 1)
        XCTAssertEqual(harness.transport.toolResults.first?["isError"]?.boolValue, true)
        XCTAssertEqual(harness.transport.toolResults.first?["result"]?.stringValue?.hasPrefix("Client tool result could not be delivered"), true)
        XCTAssertEqual(harness.takeEvents().count, 1)
    }

    func testDoesNotLoopWhenTheErrorResultCannotBeDeliveredEither() async throws {
        let harness = SessionHarness()
        var options = SessionOptions()
        options.clientTools = ["tool": { _, _ in "value" }]
        try await harness.start(options)
        _ = harness.takeEvents()
        harness.transport.sendFailures = 5
        harness.transport.agent(toolCall("tool"))
        await settle()
        XCTAssertTrue(harness.transport.toolResults.isEmpty)
        XCTAssertEqual(harness.takeEvents().count, 2)
        XCTAssertEqual(harness.transport.sendFailures, 3)
    }

    func testStopsARunningToolWhenTheSessionEndsAndSendsNothingForIt() async throws {
        let harness = SessionHarness()
        let cancelled = Flag()
        var options = SessionOptions()
        options.clientTools = ["slow": { _, _ in
            do {
                try await Task.sleep(nanoseconds: 3_600_000_000_000)
            } catch {
                await cancelled.set()
                throw error
            }
            return nil
        }]
        try await harness.start(options)
        harness.transport.agent(toolCall("slow"))
        await settle()
        harness.transport.state(.disconnected)
        await harness.scheduler.advance(by: 60000)
        let wasCancelled = await cancelled.value
        XCTAssertTrue(wasCancelled)
        XCTAssertTrue(harness.transport.toolResults.isEmpty)
    }

    func testAToolCallWithoutACallIdIsDropped() async throws {
        let harness = SessionHarness()
        var options = SessionOptions()
        options.clientTools = ["tool": { _, _ in "value" }]
        try await harness.start(options)
        _ = harness.takeEvents()
        harness.transport.agent(["type": "client_tool.call", "toolName": "tool", "expectsResponse": true])
        await settle()
        XCTAssertTrue(harness.transport.sent.isEmpty)
        XCTAssertTrue(harness.takeEvents().isEmpty)
    }
}

/// Something a test opens to let waiting code continue.
actor Gate {
    private var opened = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if opened { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        opened = true
        waiters.forEach { $0.resume() }
        waiters = []
    }
}

actor Flag {
    private(set) var value = false
    func set() { value = true }
}
