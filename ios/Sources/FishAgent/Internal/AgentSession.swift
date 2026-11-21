import Foundation
import os

/// How long after connecting the agent gets to show up. Normal joins land within a couple of seconds.
let agentJoinTimeoutMs = 15000

/// The agent's state is published seconds before its ready signal, so a state
/// alone only proves the agent joined. Queued messages wait this long for the
/// ready signal before treating the agent as an older runtime that never sends one.
let agentReadyFallbackMs = 8000

/// The runtime tears the room down right after announcing `session.ended`. If
/// that never lands, end locally with the announced reason.
let sessionEndedGraceMs = 10000

let sdkLog = Logger(subsystem: "audio.fish.agent", category: "FishAgent")

/// Everything a session needs from outside itself. Tests replace all of it.
@MainActor
struct SessionDependencies {
    let makeTransport: @MainActor () -> Transport
    let tokens: SessionTokenResolver
    let scheduler: Scheduler
    /// Receives every event, synchronously, in order.
    let onEvent: @MainActor (ConversationEvent) -> Void
}

/// One call: the state machine between the app-facing `Conversation` and the
/// transport. Port of packages/client/src/session/agentSession.ts, which is the
/// reference; behaviour written down in docs/protocol.md is followed to the letter.
@MainActor
final class AgentSession: TransportDelegate {
    let sessionId: String
    private(set) var status: ConversationStatus = .connecting
    private(set) var mode: AgentMode = .listening
    private(set) var micMuted = false
    private(set) var endReason: EndReason?

    private let transport: Transport
    private let scheduler: Scheduler
    private let onEvent: @MainActor (ConversationEvent) -> Void
    private var tools: ClientToolDispatcher!

    /// Reason announced by the runtime over `session.ended`, held until the transport disconnects.
    private var announcedEndReason: EndReason?
    private var endedGraceTimer: ScheduledWork?
    private var endedByClient = false
    private var ending: Task<Void, Error>?

    /// Text already delivered per agent segment, to work out deltas from full-text updates.
    private var agentSegments: [String: String] = [:]
    private var transcript: [TranscriptSegment] = []
    private var transcriptIndex: [String: Int] = [:]
    private var typedMessageCount = 0

    // Data packets reach only participants already in the room, and the agent
    // registers its handlers while it starts up. So typed messages wait here
    // until the agent announces itself: its ready signal, or for older
    // runtimes its first state followed by agentReadyFallbackMs without one.
    private var agentPresent = false
    /// The agent participant is in the room (any state seen), ready or not.
    private var agentJoined = false
    private var pendingMessages: [JSONValue] = []
    private var joinTimer: ScheduledWork?
    private var readyFallbackTimer: ScheduledWork?

    /// Messages on their way out. One task drains it, so they leave in the order they were queued.
    private var outbox: [JSONValue] = []
    private var draining = false

    private init(sessionId: String, transport: Transport, scheduler: Scheduler, onEvent: @escaping @MainActor (ConversationEvent) -> Void) {
        self.sessionId = sessionId
        self.transport = transport
        self.scheduler = scheduler
        self.onEvent = onEvent
    }

    var isSpeaking: Bool { mode == .speaking }

    /// Every transcript segment so far, in conversation order.
    func getTranscript() -> [TranscriptSegment] { transcript }

    // MARK: - Starting

    /// Gets a session token if needed, connects and hands back a live session.
    /// Throws `FishAgentError` when the session request or the connection fails.
    static func start(_ auth: SessionAuth, options: SessionOptions, dependencies: SessionDependencies) async throws -> AgentSession {
        let sessionToken = try await dependencies.tokens.resolve(auth, options: options)
        let transport = dependencies.makeTransport()
        let session = AgentSession(
            sessionId: sessionToken.sessionId,
            transport: transport,
            scheduler: dependencies.scheduler,
            onEvent: dependencies.onEvent
        )
        if !options.microphone { session.micMuted = true }
        session.tools = ClientToolDispatcher(
            tools: options.clientTools,
            fallbackTimeoutMs: Int((options.clientToolTimeout * 1000).rounded()),
            scheduler: dependencies.scheduler,
            send: { [transport] message in try await transport.sendClientEvent(message) },
            onError: { [weak session] error in session?.emit(.error(error)) }
        )

        do {
            try await transport.connect(sessionToken: sessionToken, delegate: session, microphone: options.microphone)
        } catch {
            // connect() can fail after the room is joined (the microphone, for
            // one); leave it, or the room stays connected with no owner.
            try? await transport.disconnect()
            session.finalize(.connectionLost)
            if error is CancellationError { throw error }
            throw error as? FishAgentError
                ?? FishAgentError(.connectionFailed, "Could not establish the realtime session", underlyingError: error)
        }

        if session.status == .connecting {
            session.setStatus(.connected)
            session.emit(.connect(sessionId: session.sessionId))
        }
        if !session.agentJoined, session.status == .connected {
            session.joinTimer = session.scheduler.schedule(afterMilliseconds: agentJoinTimeoutMs) { [weak session] in
                session?.joinTimer = nil
                session?.abandonAgentWait()
            }
        }
        return session
    }

    // MARK: - Text and control

    /// Typed turns get a text-only reply unless `audio` is true.
    func sendUserMessage(_ text: String, audio: Bool = false) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let message = ClientMessages.userMessage(text: trimmed, audio: audio)
        if agentPresent { sendClientEvent(message) } else { pendingMessages.append(message) }
        recordTypedUserMessage(trimmed)
    }

    func sendUserActivity() { sendClientEvent(ClientMessages.userActivity) }

    func interrupt() { sendClientEvent(ClientMessages.userInterrupt) }

    func registerClientTool(_ name: String, handler: @escaping ClientToolHandler) {
        tools.register(name, handler: handler)
    }

    // MARK: - Audio

    /// After a start without the microphone, the first unmute captures and publishes it.
    func setMicMuted(_ muted: Bool) async throws {
        let previous = micMuted
        micMuted = muted
        do {
            try await transport.setMicEnabled(!muted)
        } catch {
            micMuted = previous
            if error is CancellationError { throw error }
            throw error as? FishAgentError
                ?? FishAgentError(.connectionFailed, "Could not toggle the microphone", underlyingError: error)
        }
    }

    // MARK: - Ending

    /// Hangs up. Safe to call more than once: concurrent calls share one hangup.
    func end() async throws {
        if let ending { return try await ending.value }
        if status == .ended { return }
        let attempt = Task { @MainActor in try await self.endOnce() }
        ending = attempt
        do {
            try await attempt.value
        } catch {
            // A failed teardown can be tried again.
            ending = nil
            throw error
        }
    }

    private func endOnce() async throws {
        endedByClient = true
        // A graceful hangup; the participant leaving is the runtime's fallback if this is lost.
        try? await transport.sendClientEvent(ClientMessages.userHangup)
        try await transport.disconnect()
        finalize(.userHangup)
    }

    // MARK: - Internals

    private func emit(_ event: ConversationEvent) {
        onEvent(event)
    }

    private func sendClientEvent(_ message: JSONValue) {
        outbox.append(message)
        guard !draining else { return }
        draining = true
        Task { @MainActor in
            while !self.outbox.isEmpty {
                let next = self.outbox.removeFirst()
                do {
                    try await self.transport.sendClientEvent(next)
                } catch {
                    self.emit(.error(FishAgentError(.connectionFailed, "Failed to send to the agent", underlyingError: error)))
                }
            }
            self.draining = false
        }
    }

    private func setStatus(_ next: ConversationStatus) {
        guard status != next else { return }
        status = next
        emit(.statusChange(next))
    }

    private func setMode(_ next: AgentMode) {
        guard mode != next else { return }
        mode = next
        emit(.modeChange(next))
    }

    private func handleAgentPresent() {
        guard !agentPresent else { return }
        agentPresent = true
        agentJoined = true
        clearAgentTimers()
        let pending = pendingMessages
        pendingMessages = []
        pending.forEach(sendClientEvent)
    }

    private func handleAgentJoined() {
        guard !agentJoined else { return }
        agentJoined = true
        joinTimer?.cancel()
        joinTimer = nil
        if !agentPresent, status != .ended {
            readyFallbackTimer = scheduler.schedule(afterMilliseconds: agentReadyFallbackMs) { [weak self] in
                guard let self else { return }
                self.readyFallbackTimer = nil
                if self.status != .ended { self.handleAgentPresent() }
            }
        }
    }

    private func clearAgentTimers() {
        joinTimer?.cancel()
        joinTimer = nil
        readyFallbackTimer?.cancel()
        readyFallbackTimer = nil
    }

    private func abandonAgentWait() {
        guard status != .ended, !agentPresent, !agentJoined else { return }
        emit(.error(FishAgentError(.connectionFailed, "The agent did not join the session")))
        disconnectQuietly()
        finalize(.connectionLost)
    }

    /// Leaves the room without waiting and without reporting a failure: the session is ending anyway.
    private func disconnectQuietly() {
        Task { @MainActor [transport] in try? await transport.disconnect() }
    }

    private func finalize(_ reason: EndReason) {
        guard status != .ended else { return }
        clearAgentTimers()
        endedGraceTimer?.cancel()
        endedGraceTimer = nil
        tools.stop()
        endReason = reason
        setStatus(.ended)
        emit(.disconnect(reason: reason))
    }

    private func handleSessionEnded(_ reason: String?) {
        guard status != .ended, announcedEndReason == nil else { return }
        // A reason this SDK does not know voids the announcement; the transport's signals decide instead.
        guard let announced = EndReason.announced(reason) else { return }
        announcedEndReason = announced
        endedGraceTimer = scheduler.schedule(afterMilliseconds: sessionEndedGraceMs) { [weak self] in
            guard let self else { return }
            self.endedGraceTimer = nil
            self.disconnectQuietly()
            self.finalize(announced)
        }
    }

    private func toolSource(_ message: JSONValue) -> ToolCallSource {
        message["toolSource"]?.stringValue.map(ToolCallSource.init(rawValue:)) ?? .unknown
    }

    /// A known message without a field it cannot be handled without. The TypeScript client has no such check.
    private func dropped(_ message: JSONValue, missing: String) {
        sdkLog.debug("Dropped a \(message["type"]?.stringValue ?? "?", privacy: .public) message without `\(missing, privacy: .public)`")
    }

    private func recordSegment(role: MessageRole, segmentId: String, text: String, isFinal: Bool) {
        let key = "\(role.rawValue):\(segmentId)"
        let segment = TranscriptSegment(segmentId: segmentId, role: role, text: text, isFinal: isFinal)
        if let index = transcriptIndex[key] {
            transcript[index] = segment
        } else {
            transcriptIndex[key] = transcript.count
            transcript.append(segment)
        }
    }

    /// Typed messages are not echoed by the server; the sender shows its own message.
    private func recordTypedUserMessage(_ text: String) {
        typedMessageCount += 1
        let segmentId = "typed_\(typedMessageCount)"
        recordSegment(role: .user, segmentId: segmentId, text: text, isFinal: true)
        emit(.userTranscript(segmentId: segmentId, text: text, isFinal: true))
        emit(.message(role: .user, text: text))
    }

    // MARK: - TransportDelegate

    func transportDidSeeAgentReady() { handleAgentPresent() }

    // "listening" is the default mode; the agent's state supplies the thinking
    // edge; speaking follows the transcript segments.
    func transportDidSeeAgentState(_ state: String) {
        handleAgentJoined()
        if state == "thinking" { setMode(.thinking) }
    }

    func transportDidChangeConnectionState(_ state: TransportConnectionState, reason: String?) {
        guard status != .ended else { return }
        switch state {
        case .reconnecting:
            setStatus(.reconnecting)
        case .connected:
            if status == .reconnecting { setStatus(.connected) }
        case .disconnected:
            // In order of priority (docs/protocol.md, section 7): the user hung
            // up; the runtime announced why; otherwise a guess from the
            // transport. Without an announcement, an agent that left and a
            // deleted room cannot be told apart and both read as agent_hangup;
            // anything else is connection_lost.
            let ended: EndReason
            if endedByClient {
                ended = .userHangup
            } else if let announcedEndReason {
                ended = announcedEndReason
            } else if reason == DisconnectReasons.agentLeft || reason == DisconnectReasons.roomDeleted
                || reason == DisconnectReasons.roomClosed
            {
                ended = .agentHangup
            } else {
                ended = .connectionLost
            }
            finalize(ended)
        }
    }

    func transportDidReceiveTranscription(_ update: TranscriptionSegmentUpdate) {
        if update.role == .user {
            recordSegment(role: .user, segmentId: update.segmentId, text: update.text, isFinal: update.isFinal)
            emit(.userTranscript(segmentId: update.segmentId, text: update.text, isFinal: update.isFinal))
            if update.isFinal { emit(.message(role: .user, text: update.text)) }
            return
        }
        // Agent text follows playback, so streaming text means the agent is
        // audibly speaking, and the segment closing means it has finished.
        setMode(update.isFinal ? .listening : .speaking)
        recordSegment(role: .agent, segmentId: update.segmentId, text: update.text, isFinal: update.isFinal)
        let previous = agentSegments[update.segmentId] ?? ""
        let delta = update.text.hasPrefix(previous) ? String(update.text.dropFirst(previous.count)) : update.text
        agentSegments[update.segmentId] = update.text
        if !delta.isEmpty {
            emit(.agentResponseDelta(segmentId: update.segmentId, delta: delta, text: update.text))
        }
        if update.isFinal {
            agentSegments[update.segmentId] = nil
            emit(.agentResponse(segmentId: update.segmentId, text: update.text))
            emit(.message(role: .agent, text: update.text))
        }
    }

    func transportDidReceiveAgentEvent(_ message: JSONValue) {
        switch message["type"]?.stringValue {
        case "client_tool.call":
            guard let callId = message["callId"]?.stringValue else { return dropped(message, missing: "callId") }
            guard let toolName = message["toolName"]?.stringValue else { return dropped(message, missing: "toolName") }
            tools.dispatch(
                ClientToolCall(
                    callId: callId,
                    toolName: toolName,
                    params: message["params"]?.objectValue ?? [:],
                    expectsResponse: message["expectsResponse"]?.boolValue == true,
                    timeoutMs: message["timeoutMs"]?.numberValue
                )
            )
        case "tool.started":
            guard let callId = message["callId"]?.stringValue else { return dropped(message, missing: "callId") }
            guard let toolName = message["toolName"]?.stringValue else { return dropped(message, missing: "toolName") }
            emit(.toolCallStarted(ToolCallStarted(
                callId: callId,
                toolName: toolName,
                source: toolSource(message),
                input: message["input"]?.stringValue ?? "",
                inputTruncated: message["inputTruncated"]?.boolValue == true
            )))
        case "tool.completed":
            guard let callId = message["callId"]?.stringValue else { return dropped(message, missing: "callId") }
            guard let toolName = message["toolName"]?.stringValue else { return dropped(message, missing: "toolName") }
            emit(.toolCallCompleted(ToolCallCompleted(
                callId: callId,
                toolName: toolName,
                source: toolSource(message),
                output: message["output"]?.stringValue ?? "",
                outputTruncated: message["outputTruncated"]?.boolValue == true
            )))
        case "tool.failed":
            guard let callId = message["callId"]?.stringValue else { return dropped(message, missing: "callId") }
            guard let toolName = message["toolName"]?.stringValue else { return dropped(message, missing: "toolName") }
            emit(.toolCallFailed(ToolCallFailed(
                callId: callId,
                toolName: toolName,
                source: toolSource(message),
                error: message["error"]?.stringValue ?? "",
                httpStatus: message["httpStatus"]?.numberValue.map { Int($0) }
            )))
        case "session.ended":
            handleSessionEnded(message["reason"]?.stringValue)
        case "error":
            // The message carries a category only; the wording is the SDK's own.
            let provider = message["code"]?.stringValue == "provider_error"
            let recovered = message["recovered"]?.boolValue
            let base = provider ? "An upstream provider failed during the session" : "The agent runtime hit an internal error"
            emit(.error(FishAgentError(
                provider ? .providerError : .internalError,
                recovered == true ? "\(base), the agent is retrying this turn" : base,
                stage: message["stage"]?.stringValue.flatMap(FishAgentError.Stage.init(rawValue:)),
                recovered: recovered
            )))
        default:
            // Unknown message types are ignored by contract: the protocol only adds things.
            break
        }
    }
}
