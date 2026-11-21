import Foundation
import XCTest
@testable import FishAgent

/// A room the test drives by hand, or from a recording. Records every command it is given.
@MainActor
final class FakeRoomAdapter: RoomAdapter {
    weak var listener: RoomListener?
    var state: RoomState = .disconnected
    var remoteParticipantCount = 0
    var remoteAttributes: [[String: String]] = []

    /// Every command, in order: `connect`, `disconnect`, `attributes <value> @<state>`, `data <json>`, `mic true|false`.
    var commands: [String] = []
    var connectError: Error?
    var publishError: Error?
    var micError: Error?
    /// The state `connect` leaves the room in. iOS returns connected; Android returns while still connecting.
    var stateAfterConnect: RoomState = .connected

    func remoteParticipantAttributes() -> [[String: String]] { remoteAttributes }

    func connect(url _: String, token _: String) async throws {
        commands.append("connect")
        if let connectError { throw connectError }
        state = stateAfterConnect
    }

    func disconnect() async {
        commands.append("disconnect")
        state = .disconnected
    }

    func setLocalAttributes(_ attributes: [String: String]) async throws {
        commands.append("attributes \(attributes["fish.client.audio_ready"] ?? "?") @\(state.rawValue)")
    }

    func publishData(_ payload: Data, topic: String) async throws {
        if let publishError { throw publishError }
        commands.append("data \(topic) \(String(decoding: payload, as: UTF8.self))")
    }

    func setMicrophoneEnabled(_ enabled: Bool) async throws {
        if let micError { throw micError }
        commands.append("mic \(enabled)")
    }

    var audioReadyAttributes: [String] {
        commands.filter { $0.hasPrefix("attributes ") }.map { String($0.dropFirst("attributes ".count).split(separator: " ")[0]) }
    }

    var dataSent: [JSONValue] {
        commands.filter { $0.hasPrefix("data client-event ") }
            .compactMap { try? JSONValue(data: Data($0.dropFirst("data client-event ".count).utf8)) }
    }
}

/// The whole stack above the room: a session on a real transport on a fake room.
@MainActor
final class StackHarness {
    let room = FakeRoomAdapter()
    let scheduler = ManualScheduler()
    var events: [ConversationEvent] = []
    private(set) var transport: LiveKitTransport!
    var session: AgentSession!

    init() {
        transport = LiveKitTransport(room: room, scheduler: scheduler, now: { [scheduler] in nowMs + Int64(scheduler.now) })
    }

    func start(_ options: SessionOptions = SessionOptions()) async throws {
        session = try await AgentSession.start(
            .sessionToken(validToken()),
            options: options,
            dependencies: SessionDependencies(
                makeTransport: { [transport] in transport! },
                tokens: resolver(),
                scheduler: scheduler,
                onEvent: { [weak self] in self?.events.append($0) }
            )
        )
        await settle()
    }

    /// The agent joins, announces it is ready and its voice track is subscribed.
    func agentJoins() async {
        room.remoteParticipantCount = 1
        room.remoteAttributes = [["lk.agent.state": "listening", "fish.agent.ready": "1"]]
        room.listener?.roomParticipantDidConnect(attributes: [:])
        room.listener?.roomAttributesDidChange(isLocal: false, attributes: ["lk.agent.state": "listening"])
        room.listener?.roomAttributesDidChange(isLocal: false, attributes: ["fish.agent.ready": "1"])
        room.listener?.roomDidSubscribeAudioTrack(isMicrophoneSource: true)
        await settle()
    }

    var statuses: [ConversationStatus] {
        events.compactMap {
            if case let .statusChange(status) = $0 { return status }
            return nil
        }
    }

    var messages: [String] {
        events.compactMap {
            if case let .message(role, text) = $0 { return "\(role.rawValue): \(text)" }
            return nil
        }
    }

    var hasErrors: Bool {
        events.contains {
            if case .error = $0 { return true }
            return false
        }
    }
}

/// Replays an event sequence recorded from a real call (see Recordings/README.md)
/// into the room listener, at the recorded times, with the room state and
/// roster the recording shows.
@MainActor
struct Recording {
    let lines: [[String: JSONValue]]

    init(_ name: String, call: Int = 1) throws {
        let url = repositoryRoot.appendingPathComponent("ios/Tests/FishAgentTests/Recordings/\(name).jsonl")
        lines = try String(contentsOf: url, encoding: .utf8).split(separator: "\n")
            .compactMap { try JSONValue(data: Data($0.utf8)).objectValue }
            .filter { Int($0["call"]?.numberValue ?? 1) == call }
    }

    private func attributes(_ line: [String: JSONValue]) -> [String: String] {
        (line["attributes"]?.objectValue ?? [:]).compactMapValues(\.stringValue)
    }

    func index(where predicate: ([String: JSONValue]) -> Bool) -> Int {
        lines.firstIndex(where: predicate) ?? lines.count
    }

    /// Plays lines `from` (inclusive) to `until` (exclusive). `onCommand` is
    /// called for the probe's own `cmd` lines, so a test can do what the probe did.
    func replay(
        _ stack: StackHarness,
        from: Int = 0,
        until: Int? = nil,
        onCommand: (String) async throws -> Void = { _ in }
    ) async throws {
        let room = stack.room
        let origin = lines.first?["t"]?.numberValue ?? 0
        for line in lines[from ..< (until ?? lines.count)] {
            let event = line["e"]?.stringValue ?? ""
            let at = Int((line["t"]?.numberValue ?? 0) - origin)
            if at > stack.scheduler.now { await stack.scheduler.advance(by: at - stack.scheduler.now) }
            if let recorded = line["roomState"]?.stringValue.flatMap(RoomState.init(rawValue:)), stack.session != nil {
                room.state = recorded
            }
            if let remotes = line["remotes"]?.numberValue { room.remoteParticipantCount = Int(remotes) }
            let listener = room.listener
            switch event {
            case "connect.begin": try await stack.start()
            case "Connected": listener?.roomDidConnect()
            case "Reconnecting": listener?.roomDidStartReconnecting()
            case "Reconnected": listener?.roomDidReconnect()
            case "Disconnected": listener?.roomDidDisconnect(reason: line["reason"]?.stringValue ?? "")
            case "ParticipantConnected":
                room.remoteAttributes = [attributes(line)]
                listener?.roomParticipantDidConnect(attributes: attributes(line))
            case "ParticipantDisconnected":
                room.remoteAttributes = []
                listener?.roomParticipantDidDisconnect()
            case "AttributesChanged":
                let isLocal = line["isLocal"]?.boolValue == true
                if !isLocal, !room.remoteAttributes.isEmpty { room.remoteAttributes[0].merge(attributes(line)) { _, new in new } }
                listener?.roomAttributesDidChange(isLocal: isLocal, attributes: attributes(line))
            case "AudioTrackSubscribed":
                listener?.roomDidSubscribeAudioTrack(isMicrophoneSource: line["isMicrophoneSource"]?.boolValue == true)
            case "DataReceived":
                listener?.roomDidReceiveData(topic: line["topic"]?.stringValue ?? "", payload: Data((line["payload"]?.stringValue ?? "").utf8))
            case "stream.open":
                listener?.roomTextStreamDidOpen(
                    streamId: line["streamId"]?.stringValue ?? "", topic: line["topic"]?.stringValue ?? "",
                    fromLocalIdentity: line["fromLocal"]?.boolValue == true, attributes: attributes(line)
                )
            case "stream.chunk":
                listener?.roomTextStreamDidReceive(streamId: line["streamId"]?.stringValue ?? "", text: line["text"]?.stringValue ?? "")
            case "stream.close": listener?.roomTextStreamDidClose(streamId: line["streamId"]?.stringValue ?? "", aborted: false)
            case "stream.error": listener?.roomTextStreamDidClose(streamId: line["streamId"]?.stringValue ?? "", aborted: true)
            case "cmd": try await onCommand(line["cmd"]?.stringValue ?? "")
            // The probe's own actions, and facts the transport has no use for.
            case "mic.permission", "audio.session.before", "audio.session.during", "audio.session.between", "audio.session.after",
                 "token", "connect.returned", "state.connected.seen", "attr.pending.begin", "attr.pending.done", "attr.ready.done",
                 "mic.enabled", "sent", "disconnect.returned", "sticky", "probe.done":
                break
            default:
                throw TestError("recording line \(line["n"] ?? .null): unknown event \"\(event)\"; update the replay")
            }
            await settle()
        }
    }
}

@MainActor
final class LiveKitTransportTests: XCTestCase {
    private let agentOpening = "agent: Hi, thanks for calling Fernway support. How can I help with your order?"

    private func failure(_ body: () async throws -> Void) async -> FishAgentError? {
        do {
            try await body()
            return nil
        } catch {
            return error as? FishAgentError
        }
    }

    // MARK: - Replayed recordings

    func testRecordedLocalHangupEndsAsUserHangup() async throws {
        let stack = StackHarness()
        try await Recording("local-hangup").replay(stack) { command in
            if command == "hangup" { try await stack.session.end() }
        }
        XCTAssertEqual(stack.session.endReason, .userHangup)
        XCTAssertEqual(stack.statuses, [.connected, .ended])
        XCTAssertEqual(stack.messages, [agentOpening])
        XCTAssertTrue(stack.room.dataSent.contains { $0["type"]?.stringValue == "user.hangup" })
        XCTAssertFalse(stack.hasErrors)
    }

    func testRecordedJoinReportsAudioReadinessOnceAsAttributeAndMessage() async throws {
        let stack = StackHarness()
        let recording = try Recording("local-hangup")
        try await recording.replay(stack, until: recording.index { $0["e"]?.stringValue == "cmd" })

        let attributes = stack.room.audioReadyAttributes
        XCTAssertEqual(attributes.count, 2)
        XCTAssertEqual(attributes.first, "pending")
        let reports = stack.room.dataSent.filter { $0["type"]?.stringValue == "client.audio_ready" }
        XCTAssertEqual(reports.count, 1)
        XCTAssertEqual(reports.first?["at"]?.numberValue, Double(attributes[1]))
        XCTAssertEqual(stack.session.status, .connected)
        // The agent's opening line played and ended.
        XCTAssertEqual(stack.session.mode, .listening)
        XCTAssertTrue(stack.events.contains {
            if case .modeChange(.speaking) = $0 { return true }
            return false
        })
    }

    func testRecordedAgentHangupEndsWithTheAnnouncedReason() async throws {
        let stack = StackHarness()
        try await Recording("agent-hangup").replay(stack)
        // iOS reports the participant leaving while the room still reads
        // connected, a millisecond before the room is deleted.
        XCTAssertEqual(stack.session.endReason, .agentHangup)
        XCTAssertEqual(stack.statuses, [.connected, .ended])
        XCTAssertEqual(stack.messages.count, 2)
        // Past the grace period: nothing more happens.
        let before = stack.events.count
        await stack.scheduler.advance(by: agentLeftGraceMs * 3)
        XCTAssertEqual(stack.events.count, before)
    }

    func testRecordedEndForcedByTheBackendWithoutAnAnnouncementIsAgentHangup() async throws {
        let stack = StackHarness()
        try await Recording("server-end").replay(stack)
        // No session.ended reached the client this time; the deleted room decides.
        XCTAssertEqual(stack.session.endReason, .agentHangup)
        XCTAssertEqual(stack.statuses, [.connected, .ended])
    }

    func testRecordedSecondCallBehavesLikeTheFirst() async throws {
        for call in [1, 2] {
            let stack = StackHarness()
            try await Recording("two-calls", call: call).replay(stack) { command in
                if command == "hangup" { try await stack.session.end() }
            }
            XCTAssertEqual(stack.session.endReason, .userHangup, "call \(call)")
            XCTAssertEqual(stack.statuses, [.connected, .ended], "call \(call)")
            XCTAssertEqual(stack.messages, [agentOpening], "call \(call)")
            XCTAssertEqual(stack.room.audioReadyAttributes.count, 2, "call \(call)")
        }
    }

    func testAttributesWithEmptyValuesAreNotSignals() async throws {
        // iOS reports a departing participant's attributes once more with empty
        // values (see the tail of local-hangup.jsonl). Empty is the same as absent.
        let stack = StackHarness()
        try await stack.start()
        stack.room.remoteParticipantCount = 1
        stack.session.sendUserMessage("hello")
        stack.room.listener?.roomAttributesDidChange(isLocal: false, attributes: ["fish.agent.ready": "", "lk.agent.state": ""])
        await settle()
        XCTAssertTrue(stack.room.dataSent.isEmpty, "an empty ready value must not release queued messages")
        // An empty state does not prove the agent joined either: the join timeout still runs.
        await stack.scheduler.advance(by: agentJoinTimeoutMs)
        XCTAssertEqual(stack.session.endReason, .connectionLost)
    }

    // MARK: - What the recordings do not cover

    func testAnEmptyRosterThatStaysEmptyAfterAReconnectIsTheAgentHangingUp() async throws {
        let stack = StackHarness()
        try await stack.start()
        await stack.agentJoins()
        stack.room.state = .reconnecting
        stack.room.listener?.roomDidStartReconnecting()
        stack.room.remoteParticipantCount = 0
        stack.room.listener?.roomParticipantDidDisconnect()
        stack.room.state = .connected
        stack.room.listener?.roomDidReconnect()
        await stack.scheduler.advance(by: rosterGraceMs - 1)
        XCTAssertEqual(stack.session.status, .connected)
        await stack.scheduler.advance(by: 1)
        XCTAssertEqual(stack.session.endReason, .agentHangup)
        XCTAssertEqual(stack.room.commands.last, "disconnect")
    }

    func testAReconnectReportedBeforeTheAgentIsBackInTheRosterIsNotAHangup() async throws {
        // The order recorded on Android after a 40 s outage.
        let stack = StackHarness()
        try await stack.start()
        await stack.agentJoins()
        stack.room.state = .reconnecting
        stack.room.listener?.roomDidStartReconnecting()
        stack.room.remoteParticipantCount = 0
        stack.room.listener?.roomParticipantDidDisconnect()
        stack.room.state = .connected
        stack.room.listener?.roomDidReconnect()
        await stack.scheduler.advance(by: 41)
        stack.room.remoteParticipantCount = 1
        stack.room.listener?.roomParticipantDidConnect(attributes: ["lk.agent.state": "listening", "fish.agent.ready": "1"])
        await stack.scheduler.advance(by: rosterGraceMs * 3)
        XCTAssertEqual(stack.statuses, [.connected, .reconnecting, .connected])
        XCTAssertNil(stack.session.endReason)
        // The readiness value is set again after the reconnect, unchanged.
        let attributes = stack.room.audioReadyAttributes
        XCTAssertEqual(attributes.count, 3)
        XCTAssertEqual(attributes[1], attributes[2])
    }

    func testTheAgentLeavingARoomThatStaysConnectedIsAgentHangupAfterTheGrace() async throws {
        let stack = StackHarness()
        try await stack.start()
        await stack.agentJoins()
        // As iOS reports it: the roster still counts the participant when the event arrives.
        stack.room.listener?.roomParticipantDidDisconnect()
        stack.room.remoteParticipantCount = 0
        await stack.scheduler.advance(by: agentLeftGraceMs - 1)
        XCTAssertEqual(stack.session.status, .connected)
        await stack.scheduler.advance(by: 1)
        XCTAssertEqual(stack.session.endReason, .agentHangup)
        XCTAssertEqual(stack.room.commands.last, "disconnect")
    }

    func testAReconnectThatStartsRightBehindADepartureIsNotAHangup() async throws {
        let stack = StackHarness()
        try await stack.start()
        await stack.agentJoins()
        stack.room.listener?.roomParticipantDidDisconnect()
        stack.room.remoteParticipantCount = 0
        await stack.scheduler.advance(by: 1)
        stack.room.state = .reconnecting
        stack.room.listener?.roomDidStartReconnecting()
        await stack.scheduler.advance(by: agentLeftGraceMs * 3)
        XCTAssertEqual(stack.session.status, .reconnecting)
        XCTAssertNil(stack.session.endReason)
    }

    func testOneOfTwoRemoteParticipantsLeavingIsNotTheAgentLeaving() async throws {
        let stack = StackHarness()
        try await stack.start()
        await stack.agentJoins()
        stack.room.remoteParticipantCount = 2
        stack.room.listener?.roomParticipantDidDisconnect()
        stack.room.remoteParticipantCount = 1
        await stack.scheduler.advance(by: agentLeftGraceMs * 3)
        XCTAssertEqual(stack.session.status, .connected)
    }

    func testAnAgentAlreadyInTheRoomIsReadFromItsStickyAttributes() async throws {
        let stack = StackHarness()
        stack.room.remoteParticipantCount = 1
        stack.room.remoteAttributes = [["lk.agent.state": "listening", "fish.agent.ready": "1"]]
        try await stack.start()
        stack.session.sendUserMessage("hello")
        await settle()
        // Sent at once: the ready signal was read on connect, no change event needed.
        XCTAssertEqual(stack.room.dataSent.map { $0["type"]?.stringValue }, ["user.message"])
    }

    func testPendingIsSetBeforeTheReadyStampEvenWhenTheTrackArrivesAtOnce() async throws {
        let stack = StackHarness()
        try await stack.start()
        stack.room.listener?.roomDidSubscribeAudioTrack(isMicrophoneSource: true)
        await settle()
        let attributes = stack.room.audioReadyAttributes
        XCTAssertEqual(attributes.count, 2)
        XCTAssertEqual(attributes[0], "pending")
        XCTAssertNotEqual(attributes[1], "pending")
    }

    func testOnlyTheMicrophoneSourceTrackCountsAsTheAgentsVoice() async throws {
        let stack = StackHarness()
        try await stack.start()
        stack.room.listener?.roomDidSubscribeAudioTrack(isMicrophoneSource: false)
        await settle()
        XCTAssertEqual(stack.room.audioReadyAttributes, ["pending"])
        stack.room.listener?.roomDidSubscribeAudioTrack(isMicrophoneSource: true)
        stack.room.listener?.roomDidSubscribeAudioTrack(isMicrophoneSource: true)
        await settle()
        XCTAssertEqual(stack.room.audioReadyAttributes.count, 2)
        XCTAssertEqual(stack.room.dataSent.filter { $0["type"]?.stringValue == "client.audio_ready" }.count, 1)
    }

    func testAFailedReadinessReportDoesNotBreakTheCall() async throws {
        let stack = StackHarness()
        try await stack.start()
        stack.room.publishError = TestError("data channel closed")
        stack.room.listener?.roomDidSubscribeAudioTrack(isMicrophoneSource: true)
        await settle()
        XCTAssertEqual(stack.session.status, .connected)
        XCTAssertFalse(stack.hasErrors)
    }

    func testTheMicrophoneIsPublishedDuringConnectUnlessTheCallStartsWithoutIt() async throws {
        let withMic = StackHarness()
        try await withMic.start()
        XCTAssertTrue(withMic.room.commands.contains("mic true"))

        let withoutMic = StackHarness()
        var options = SessionOptions()
        options.microphone = false
        try await withoutMic.start(options)
        XCTAssertFalse(withoutMic.room.commands.contains { $0.hasPrefix("mic ") })
        try await withoutMic.session.setMicMuted(false)
        XCTAssertEqual(withoutMic.room.commands.last, "mic true")
        XCTAssertFalse(withoutMic.session.micMuted)
    }

    func testAMicrophoneFailureDuringConnectFailsTheStartAndLeavesTheRoom() async {
        let stack = StackHarness()
        stack.room.micError = FishAgentError(.micPermissionDenied, "denied")
        let error = await failure { try await stack.start() }
        XCTAssertEqual(error?.code, .micPermissionDenied)
        XCTAssertEqual(stack.room.commands.last, "disconnect")
    }

    func testARoomThatFailsToConnectFailsTheStartAsConnectionFailed() async {
        let stack = StackHarness()
        stack.room.connectError = TestError("could not reach the server")
        let error = await failure { try await stack.start() }
        XCTAssertEqual(error?.code, .connectionFailed)
    }

    func testARoomThatIsStillConnectingWhenConnectReturnsIsWaitedFor() async throws {
        let stack = StackHarness()
        stack.room.stateAfterConnect = .connecting
        let starting = Task { try await stack.start() }
        await settle()
        // Nothing may be set before the room is connected.
        XCTAssertEqual(stack.room.commands, ["connect"])
        stack.room.state = .connected
        stack.room.listener?.roomDidConnect()
        try await starting.value
        XCTAssertEqual(stack.room.audioReadyAttributes.first, "pending")
        XCTAssertTrue(stack.room.commands.contains("attributes pending @connected"))
    }

    func testARoomThatNeverReportsConnectedFailsTheStartAfterTheTimeout() async {
        let stack = StackHarness()
        stack.room.stateAfterConnect = .connecting
        let starting = Task { try await stack.start() }
        await settle()
        await stack.scheduler.advance(by: roomConnectedTimeoutMs)
        let error = await failure { try await starting.value }
        XCTAssertEqual(error?.code, .connectionFailed)
        XCTAssertEqual(stack.room.commands.last, "disconnect")
    }

    func testARoomThatDisconnectsWhileConnectingFailsTheStart() async {
        let stack = StackHarness()
        stack.room.stateAfterConnect = .connecting
        let starting = Task { try await stack.start() }
        await settle()
        stack.room.state = .disconnected
        stack.room.listener?.roomDidDisconnect(reason: "joinFailure")
        let error = await failure { try await starting.value }
        XCTAssertEqual(error?.code, .connectionFailed)
    }

    func testDataOnOtherTopicsOrThatIsNotATypedJSONObjectIsDropped() async throws {
        let stack = StackHarness()
        try await stack.start()
        stack.events = []
        let listener = stack.room.listener
        let errorMessage = Data(#"{"type":"error","code":"internal_error"}"#.utf8)
        listener?.roomDidReceiveData(topic: "client-event", payload: errorMessage)
        listener?.roomDidReceiveData(topic: "", payload: errorMessage)
        listener?.roomDidReceiveData(topic: "agent-event", payload: Data("not json".utf8))
        listener?.roomDidReceiveData(topic: "agent-event", payload: Data("[1,2]".utf8))
        listener?.roomDidReceiveData(topic: "agent-event", payload: Data(#"{"code":"internal_error"}"#.utf8))
        listener?.roomDidReceiveData(topic: "agent-event", payload: Data(#"{"type":7}"#.utf8))
        XCTAssertTrue(stack.events.isEmpty)
        listener?.roomDidReceiveData(topic: "agent-event", payload: errorMessage)
        XCTAssertEqual(stack.events.count, 1)
    }

    func testTranscriptStreamsFollowTheStreamRules() async throws {
        let stack = StackHarness()
        try await stack.start()
        stack.events = []
        let listener = stack.room.listener!
        let topic = WireProtocol.transcriptionTopic

        // No segment id: ignored.
        listener.roomTextStreamDidOpen(streamId: "s0", topic: topic, fromLocalIdentity: false, attributes: [:])
        listener.roomTextStreamDidReceive(streamId: "s0", text: "ignored")
        listener.roomTextStreamDidClose(streamId: "s0", aborted: false)
        // Another topic: ignored.
        listener.roomTextStreamDidOpen(streamId: "s1", topic: "chat", fromLocalIdentity: false, attributes: ["lk.segment_id": "SG_x"])
        listener.roomTextStreamDidReceive(streamId: "s1", text: "ignored")
        listener.roomTextStreamDidClose(streamId: "s1", aborted: false)
        // An empty stream produces nothing.
        listener.roomTextStreamDidOpen(streamId: "s2", topic: topic, fromLocalIdentity: false, attributes: ["lk.segment_id": "SG_empty"])
        listener.roomTextStreamDidClose(streamId: "s2", aborted: false)
        XCTAssertTrue(stack.events.isEmpty)

        // The user's speech: each update is a stream of its own carrying the whole text.
        listener.roomTextStreamDidOpen(streamId: "u1", topic: topic, fromLocalIdentity: true, attributes: ["lk.segment_id": "SG_u", "lk.transcription_final": "false"])
        listener.roomTextStreamDidReceive(streamId: "u1", text: "where is")
        listener.roomTextStreamDidClose(streamId: "u1", aborted: false)
        listener.roomTextStreamDidOpen(streamId: "u2", topic: topic, fromLocalIdentity: true, attributes: ["lk.segment_id": "SG_u", "lk.transcription_final": "true"])
        listener.roomTextStreamDidReceive(streamId: "u2", text: "where is my order")
        listener.roomTextStreamDidClose(streamId: "u2", aborted: false)
        XCTAssertEqual(stack.messages, ["user: where is my order"])

        // A user stream marked final but aborted is not final.
        stack.events = []
        listener.roomTextStreamDidOpen(streamId: "u3", topic: topic, fromLocalIdentity: true, attributes: ["lk.segment_id": "SG_u3", "lk.transcription_final": "true"])
        listener.roomTextStreamDidReceive(streamId: "u3", text: "half a sen")
        listener.roomTextStreamDidClose(streamId: "u3", aborted: true)
        XCTAssertEqual(stack.messages, [])

        // An interrupted agent reply is final with what was spoken.
        listener.roomTextStreamDidOpen(streamId: "a1", topic: topic, fromLocalIdentity: false, attributes: ["lk.segment_id": "SG_a"])
        listener.roomTextStreamDidReceive(streamId: "a1", text: "Your order")
        listener.roomTextStreamDidReceive(streamId: "a1", text: " is on")
        listener.roomTextStreamDidClose(streamId: "a1", aborted: true)
        XCTAssertEqual(stack.messages, ["agent: Your order is on"])
        XCTAssertEqual(stack.session.mode, .listening)
    }

    func testOurOwnPacketsComingBackAfterAReconnectAreIgnored() async throws {
        // Seen on Android: after a reconnect, client.audio_ready returns on client-event with no sender.
        let stack = StackHarness()
        try await stack.start()
        await stack.agentJoins()
        stack.events = []
        stack.room.listener?.roomDidReceiveData(topic: "client-event", payload: Data(#"{"type":"client.audio_ready","at":1}"#.utf8))
        XCTAssertTrue(stack.events.isEmpty)
    }

    func testSendingAfterTheSessionLeftTheRoomFails() async throws {
        let stack = StackHarness()
        try await stack.start()
        try await stack.transport.disconnect()
        let error = await failure { try await stack.transport.sendClientEvent(ClientMessages.userActivity) }
        XCTAssertEqual(error?.code, .connectionFailed)
    }

    func testNothingIsReportedAfterADisconnectWasReported() async throws {
        let stack = StackHarness()
        try await stack.start()
        await stack.agentJoins()
        stack.room.listener?.roomParticipantDidDisconnect()
        stack.room.remoteParticipantCount = 0
        await stack.scheduler.advance(by: agentLeftGraceMs)
        XCTAssertEqual(stack.session.endReason, .agentHangup)
        let count = stack.events.count
        // LiveKit then reports the disconnect we asked for.
        stack.room.listener?.roomDidDisconnect(reason: "CLIENT_INITIATED")
        XCTAssertEqual(stack.events.count, count)
    }
}
