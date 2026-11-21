import Foundation
import XCTest
@testable import FishAgent

/// The device, faked: the microphone permission, audio routing, and one `FakeTransport` per call.
@MainActor
final class FakeEnvironment: ConversationEnvironment {
    let manualScheduler = ManualScheduler()
    var scheduler: Scheduler { manualScheduler }
    let tokens: SessionTokenResolver

    var microphoneGranted = true
    var permissionRequests = 0
    /// One per call, in order. Set `nextTransport` to prepare the next call's transport before it starts.
    var transports: [FakeTransport] = []
    var nextTransport = FakeTransport()
    /// Every route applied, with whether a call was live.
    var routes: [String] = []
    var callEnds = 0

    var transport: FakeTransport { transports[transports.count - 1] }

    init(http: FakeHTTP = FakeHTTP()) {
        tokens = resolver(http)
    }

    func requestMicrophonePermission() async -> Bool {
        permissionRequests += 1
        return microphoneGranted
    }

    func makeTransport() -> Transport {
        let created = nextTransport
        nextTransport = FakeTransport()
        transports.append(created)
        return created
    }

    func applyAudioOutput(_ route: AudioOutputRoute, callActive: Bool) {
        routes.append("\(route.rawValue)\(callActive ? " live" : "")")
    }

    func callDidEnd() { callEnds += 1 }
}

@MainActor
final class ConversationTests: XCTestCase {
    private let auth = SessionAuth.sessionToken(validToken())

    override func tearDown() async throws {
        await MainActor.run { CallSlot.clearForTests() }
    }

    private func make(
        _ environment: FakeEnvironment? = nil,
        defaults: SessionOptions = SessionOptions(),
        mobile: MobileOptions = MobileOptions()
    ) -> (Conversation, FakeEnvironment) {
        let environment = environment ?? FakeEnvironment()
        return (Conversation(defaults: defaults, mobile: mobile, environment: environment), environment)
    }

    private func failure(_ body: () async throws -> Void) async -> Error? {
        do {
            try await body()
            return nil
        } catch {
            return error
        }
    }

    // MARK: - Starting

    func testStartsACallAndMirrorsItsState() async throws {
        let (conversation, environment) = make()
        XCTAssertEqual(conversation.status, .idle)
        XCTAssertNil(conversation.sessionId)

        let id = try await conversation.startSession(auth)

        XCTAssertEqual(id, "sess-1")
        XCTAssertEqual(conversation.sessionId, "sess-1")
        XCTAssertEqual(conversation.status, .connected)
        XCTAssertEqual(conversation.mode, .listening)
        XCTAssertFalse(conversation.micMuted)
        XCTAssertEqual(environment.transports.count, 1)
        XCTAssertEqual(environment.permissionRequests, 1)
        XCTAssertEqual(environment.routes, ["auto", "auto live"])
    }

    func testASecondStartWhileOneIsOnItsWayJoinsIt() async throws {
        let (conversation, environment) = make()
        environment.nextTransport.holdConnect = true
        let first = Task { try await conversation.startSession(self.auth) }
        let second = Task { try await conversation.startSession(self.auth) }
        await settle()
        XCTAssertEqual(conversation.status, .connecting)
        environment.transport.releaseConnect()
        let ids = [try await first.value, try await second.value]
        XCTAssertEqual(ids, ["sess-1", "sess-1"])
        XCTAssertEqual(environment.transports.count, 1)
    }

    func testAStartDuringALiveCallReturnsThatCall() async throws {
        let (conversation, environment) = make()
        try await conversation.startSession(auth)
        let again = try await conversation.startSession(auth)
        XCTAssertEqual(again, "sess-1")
        XCTAssertEqual(environment.transports.count, 1)
    }

    func testAFailedStartGoesBackToIdleAndReleasesEverything() async throws {
        let (conversation, environment) = make()
        environment.nextTransport.connectError = TestError("ice failed")
        let error = await failure { try await conversation.startSession(self.auth) } as? FishAgentError
        XCTAssertEqual(error?.code, .connectionFailed)
        XCTAssertEqual(conversation.status, .idle)
        XCTAssertNil(conversation.endReason)
        XCTAssertEqual(environment.callEnds, 1)

        // Nothing is left held: the next start works, here or in another conversation.
        let (other, _) = make()
        let id = try await other.startSession(auth)
        XCTAssertEqual(id, "sess-1")
    }

    func testAFailedSessionRequestCreatesNoTransport() async {
        let environment = FakeEnvironment(http: FakeHTTP(status: 402, body: #"{"message":"Out of credit"}"#))
        let (conversation, _) = make(environment)
        let error = await failure { try await conversation.startSession(.agentId("agent-1")) } as? FishAgentError
        XCTAssertEqual(error?.code, .insufficientCredit)
        XCTAssertTrue(environment.transports.isEmpty)
        XCTAssertEqual(conversation.status, .idle)
    }

    func testWithoutTheMicrophonePermissionTheStartFailsBeforeAnythingIsCreated() async {
        let http = FakeHTTP()
        let environment = FakeEnvironment(http: http)
        environment.microphoneGranted = false
        let (conversation, _) = make(environment)
        let error = await failure { try await conversation.startSession(.agentId("agent-1")) } as? FishAgentError
        XCTAssertEqual(error?.code, .micPermissionDenied)
        XCTAssertTrue(http.requests.isEmpty, "no server session may be created")
        XCTAssertTrue(environment.transports.isEmpty)
        XCTAssertEqual(conversation.status, .idle)
    }

    func testACallWithoutTheMicrophoneDoesNotAskForItUntilTheFirstUnmute() async throws {
        let environment = FakeEnvironment()
        environment.microphoneGranted = false
        let (conversation, _) = make(environment)
        try await conversation.startSession(auth) { $0.microphone = false }
        XCTAssertEqual(environment.permissionRequests, 0)
        XCTAssertTrue(conversation.micMuted)
        XCTAssertEqual(environment.transport.connectedWithMicrophone, false)

        let denied = await failure { try await conversation.setMicMuted(false) } as? FishAgentError
        XCTAssertEqual(denied?.code, .micPermissionDenied)
        XCTAssertTrue(conversation.micMuted)

        environment.microphoneGranted = true
        try await conversation.setMicMuted(false)
        XCTAssertFalse(conversation.micMuted)
        XCTAssertTrue(environment.transport.micEnabled)
    }

    func testMuteDoesNothingWithoutACall() async throws {
        let (conversation, _) = make()
        try await conversation.setMicMuted(true)
        XCTAssertFalse(conversation.micMuted)
    }

    // MARK: - Ending

    func testHangingUpEndsTheCallAndPutsTheAudioBack() async throws {
        let (conversation, environment) = make()
        try await conversation.startSession(auth)
        try await conversation.endSession()
        XCTAssertEqual(conversation.status, .ended)
        XCTAssertEqual(conversation.endReason, .userHangup)
        XCTAssertEqual(environment.callEnds, 1)
        XCTAssertEqual(environment.transport.disconnectCalls, 1)
        // Again does nothing.
        try await conversation.endSession()
        XCTAssertEqual(environment.transport.disconnectCalls, 1)
        XCTAssertEqual(environment.callEnds, 1)
    }

    func testACallEndedByTheOtherSidePutsTheAudioBackToo() async throws {
        let (conversation, environment) = make()
        try await conversation.startSession(auth)
        environment.transport.state(.disconnected, reason: DisconnectReasons.roomDeleted)
        XCTAssertEqual(conversation.status, .ended)
        XCTAssertEqual(conversation.endReason, .agentHangup)
        XCTAssertEqual(environment.callEnds, 1)
        XCTAssertEqual(conversation.sessionId, "sess-1")
    }

    func testHangingUpDuringAStartCancelsItAndClosesTheLateSession() async throws {
        let (conversation, environment) = make()
        environment.nextTransport.holdConnect = true
        let start = Task { try await conversation.startSession(self.auth) }
        await settle()
        let hangup = Task { try await conversation.endSession() }
        await settle()
        XCTAssertEqual(conversation.status, .ended)

        environment.transport.releaseConnect()
        try await hangup.value
        let error = await failure { _ = try await start.value }
        XCTAssertTrue(error is CancellationError)
        XCTAssertEqual(environment.transport.disconnectCalls, 1, "the late session must be closed")
        XCTAssertEqual(conversation.status, .ended)
        XCTAssertNil(conversation.sessionId)
        XCTAssertEqual(environment.callEnds, 1)
    }

    func testAStartRightAfterHangingUpOnAStartWaitsForItAndThenConnects() async throws {
        let (conversation, environment) = make()
        environment.nextTransport.holdConnect = true
        let first = Task { try await conversation.startSession(self.auth) }
        await settle()
        let firstTransport = environment.transport
        let hangup = Task { try await conversation.endSession() }
        await settle()
        // Not awaited: the user taps call again at once.
        let second = Task { try await conversation.startSession(self.auth) }
        await settle()
        XCTAssertEqual(environment.transports.count, 1, "the new call waits for the old start to finish")
        XCTAssertEqual(conversation.status, .connecting)

        firstTransport.releaseConnect()
        let id = try await second.value
        try await hangup.value
        XCTAssertEqual(id, "sess-1")
        let error = await failure { _ = try await first.value }
        XCTAssertTrue(error is CancellationError)
        XCTAssertEqual(environment.transports.count, 2)
        XCTAssertEqual(conversation.status, .connected)
        XCTAssertEqual(firstTransport.disconnectCalls, 1)
        // The audio now belongs to the second call: the first start's release did not take it away after.
        XCTAssertEqual(environment.routes.last, "auto live")
    }

    func testACancelledCallerStopsWaitingButTheCallStillStarts() async throws {
        let (conversation, environment) = make()
        environment.nextTransport.holdConnect = true
        let caller = Task { try await conversation.startSession(self.auth) }
        await settle()
        caller.cancel()
        let error = await failure { _ = try await caller.value }
        XCTAssertTrue(error is CancellationError)
        XCTAssertEqual(conversation.status, .connecting)
        environment.transport.releaseConnect()
        await settle()
        XCTAssertEqual(conversation.status, .connected)
        XCTAssertEqual(conversation.sessionId, "sess-1")
    }

    // MARK: - One call per process

    func testASecondConversationCannotStartWhileTheFirstHasACall() async throws {
        let (first, _) = make()
        let (second, secondEnvironment) = make()
        try await first.startSession(auth)

        let error = await failure { try await second.startSession(self.auth) }
        guard case .callAlreadyActive? = error as? ConversationUsageError else { return XCTFail("got \(String(describing: error))") }
        XCTAssertTrue(secondEnvironment.transports.isEmpty)
        XCTAssertEqual(second.status, .idle)

        try await first.endSession()
        let id = try await second.startSession(auth)
        XCTAssertEqual(id, "sess-1")
    }

    func testTheSlotIsFreeAgainAfterTheOtherSideEndsTheCall() async throws {
        let (first, firstEnvironment) = make()
        let (second, _) = make()
        try await first.startSession(auth)
        firstEnvironment.transport.state(.disconnected)
        let id = try await second.startSession(auth)
        XCTAssertEqual(id, "sess-1")
    }

    // MARK: - Sending

    func testSendersDoNothingWithoutACall() async throws {
        let (conversation, environment) = make()
        conversation.sendUserMessage("hello")
        conversation.sendUserActivity()
        conversation.interrupt()
        await settle()
        XCTAssertTrue(environment.transports.isEmpty)
        XCTAssertTrue(conversation.messages.isEmpty)

        try await conversation.startSession(auth)
        try await conversation.endSession()
        conversation.sendUserMessage("after the call")
        await settle()
        XCTAssertEqual(environment.transport.sent.map { $0["type"]?.stringValue }, ["user.hangup"])
    }

    func testATypedMessageIsSentAndShown() async throws {
        let (conversation, environment) = make()
        try await conversation.startSession(auth)
        environment.transport.agentState("initializing")
        environment.transport.ready()
        conversation.sendUserMessage("where is my order?")
        await settle()
        XCTAssertEqual(environment.transport.sent.first?["text"]?.stringValue, "where is my order?")
        XCTAssertEqual(conversation.messages, [ChatMessage(id: "user-typed_1", role: .user, text: "where is my order?", isFinal: true)])
    }

    // MARK: - Messages and events

    func testMessagesStreamInPlaceStayAfterTheCallAndAreEmptiedByTheNextOne() async throws {
        let (conversation, environment) = make()
        try await conversation.startSession(auth)
        let transport = environment.transport
        transport.transcription("SG_1", .agent, "Hi", isFinal: false)
        XCTAssertEqual(conversation.messages, [ChatMessage(id: "agent-SG_1", role: .agent, text: "Hi", isFinal: false)])
        transport.transcription("SG_2", .user, "where", isFinal: false)
        transport.transcription("SG_1", .agent, "Hi there", isFinal: true)
        transport.transcription("SG_2", .user, "where is it", isFinal: true)
        let expected = [
            ChatMessage(id: "agent-SG_1", role: .agent, text: "Hi there", isFinal: true),
            ChatMessage(id: "user-SG_2", role: .user, text: "where is it", isFinal: true),
        ]
        XCTAssertEqual(conversation.messages, expected)

        try await conversation.endSession()
        XCTAssertEqual(conversation.messages, expected)
        XCTAssertEqual(conversation.transcript().count, 2)

        try await conversation.startSession(auth)
        XCTAssertTrue(conversation.messages.isEmpty)
        XCTAssertNil(conversation.endReason)
        XCTAssertEqual(conversation.status, .connected)
    }

    func testEveryEventStreamGetsEveryEventAndNothingIsReplayed() async throws {
        let (conversation, environment) = make()
        let firstStream = conversation.events()
        let secondStream = conversation.events()
        let first = Task { @MainActor in
            var seen: [String] = []
            for await event in firstStream { seen.append(fixtureForm(event).name); if seen.count == 3 { break } }
            return seen
        }
        let second = Task { @MainActor in
            var seen: [String] = []
            for await event in secondStream { seen.append(fixtureForm(event).name); if seen.count == 3 { break } }
            return seen
        }
        try await conversation.startSession(auth)
        // A stream made now sees nothing from before.
        let lateStream = conversation.events()
        let late = Task { @MainActor in
            var seen: [String] = []
            for await event in lateStream { seen.append(fixtureForm(event).name); if seen.count == 1 { break } }
            return seen
        }
        await settle()
        environment.transport.agentState("thinking")
        let all = [await first.value, await second.value]
        XCTAssertEqual(all, [["statusChange", "connect", "modeChange"], ["statusChange", "connect", "modeChange"]])
        let lateSeen = await late.value
        XCTAssertEqual(lateSeen, ["modeChange"])
        XCTAssertEqual(conversation.mode, .thinking)
    }

    func testAFailedStartReportsItsEventsButLeavesNoEndReason() async {
        let (conversation, environment) = make()
        let stream = conversation.events()
        let seen = Task { @MainActor in
            var names: [String] = []
            for await event in stream { names.append(fixtureForm(event).name); if names.count == 2 { break } }
            return names
        }
        environment.nextTransport.connectError = TestError("ice failed")
        _ = await failure { try await conversation.startSession(self.auth) }
        let names = await seen.value
        XCTAssertEqual(names, ["statusChange", "disconnect"])
        XCTAssertEqual(conversation.status, .idle)
        XCTAssertNil(conversation.endReason)
    }

    // MARK: - Audio route and tools

    func testTheAudioRouteAppliesToTheCallAndIsKeptForTheNextOne() async throws {
        let (conversation, environment) = make(mobile: MobileOptions(audioOutput: .speaker))
        XCTAssertEqual(conversation.audioOutput, .speaker)
        conversation.setAudioOutput(.earpiece)
        XCTAssertEqual(conversation.audioOutput, .earpiece)
        XCTAssertTrue(environment.routes.isEmpty, "nothing to route before a call")

        try await conversation.startSession(auth)
        XCTAssertEqual(environment.routes, ["earpiece", "earpiece live"])
        conversation.setAudioOutput(.auto)
        XCTAssertEqual(environment.routes.last, "auto live")

        try await conversation.endSession()
        let count = environment.routes.count
        conversation.setAudioOutput(.speaker)
        XCTAssertEqual(environment.routes.count, count, "the ended call's audio is not touched")
        try await conversation.startSession(auth)
        XCTAssertEqual(environment.routes.last, "speaker live")
    }

    func testAToolRegisteredOnTheConversationServesThisCallAndLaterOnes() async throws {
        var defaults = SessionOptions()
        defaults.clientTools = ["from_defaults": { _, _ in "defaults" }]
        let (conversation, environment) = make(defaults: defaults)
        func call(_ tool: String) -> JSONValue {
            ["type": "client_tool.call", "callId": .string("call-\(tool)"), "toolName": .string(tool), "params": [:], "expectsResponse": true]
        }
        func results(_ transport: FakeTransport) -> Set<String> {
            Set(transport.toolResults.compactMap { $0["result"]?.stringValue })
        }

        try await conversation.startSession(auth)
        conversation.registerClientTool("registered") { _, _ in "registered" }
        environment.transport.agent(call("registered"))
        environment.transport.agent(call("from_defaults"))
        await settle()
        XCTAssertEqual(results(environment.transport), ["registered", "defaults"])

        try await conversation.endSession()
        try await conversation.startSession(auth) { $0.clientTools = ["registered": { _, _ in "per call" }] }
        environment.transport.agent(call("registered"))
        environment.transport.agent(call("from_defaults"))
        await settle()
        XCTAssertEqual(results(environment.transport), ["per call", "defaults"], "per-call tools win")
    }

    func testReleasingTheConversationEndsItsCall() async throws {
        let environment = FakeEnvironment()
        var conversation: Conversation? = Conversation(defaults: SessionOptions(), mobile: MobileOptions(), environment: environment)
        try await conversation?.startSession(auth)
        conversation = nil
        await settle()
        XCTAssertEqual(environment.transport.disconnectCalls, 1)
        XCTAssertEqual(environment.callEnds, 1)
        // The slot is free for another conversation.
        let (other, _) = make()
        let id = try await other.startSession(auth)
        XCTAssertEqual(id, "sess-1")
    }
}
