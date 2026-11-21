import Foundation

/// How long the room gets to report connected after `connect` returns. On iOS
/// it is connected by then; this guards against a version where it is not.
let roomConnectedTimeoutMs = 20000

/// After a reconnect, how long the agent gets to reappear in the roster before
/// it counts as gone. Measured on Android: the reconnect can be reported
/// before the roster is rebuilt (41 ms after a 40 s outage).
let rosterGraceMs = 2000

/// How long after the last remote participant leaves before it counts as the
/// agent hanging up. On iOS the participant's departure is reported while the
/// room still reads connected, a millisecond before the disconnect or
/// reconnect that explains it.
let agentLeftGraceMs = 1000

/// The production transport: the rules of docs/protocol.md on top of a LiveKit
/// room. The logic follows packages/client/src/transport/livekit.ts and the
/// Android transport, except where LiveKit behaves differently on iOS. Each
/// such place is marked "iOS:" and comes from the recordings in
/// Tests/FishAgentTests/Recordings (see the README there).
@MainActor
final class LiveKitTransport: Transport, RoomListener {
    private let room: RoomAdapter
    private let scheduler: Scheduler
    /// Current time in epoch ms, for the audio-ready stamp.
    private let now: () -> Int64

    private weak var delegate: TransportDelegate?
    /// Resumed when the room first reports connected, or fails before that.
    private var connected: CheckedContinuation<Void, Error>?
    /// The epoch-ms value published as `fish.client.audio_ready`, kept to publish again after a reconnect.
    private var audioReadyStamp: String?
    /// A disconnect was already reported to the session; nothing more is reported.
    private var ended = false
    private var rosterGrace: ScheduledWork?
    private var agentLeftGrace: ScheduledWork?
    /// Attribute updates in the order they were asked for.
    private var attributeUpdates: Task<Void, Never>?

    private struct TextStream {
        let segmentId: String
        let role: MessageRole
        let finalAttribute: Bool
        var text = ""
    }

    private var streams: [String: TextStream] = [:]

    init(room: RoomAdapter, scheduler: Scheduler, now: @escaping () -> Int64) {
        self.room = room
        self.scheduler = scheduler
        self.now = now
    }

    // MARK: - Transport

    func connect(sessionToken: SessionToken, delegate: TransportDelegate, microphone: Bool) async throws {
        guard let url = sessionToken.livekitUrl, !url.isEmpty, let token = sessionToken.token, !token.isEmpty else {
            throw FishAgentError(.connectionFailed, "The session token has no LiveKit URL or join token")
        }
        self.delegate = delegate
        room.listener = self
        do {
            try await room.connect(url: url, token: token)
            try await waitUntilConnected()
        } catch let error as FishAgentError {
            throw error
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw FishAgentError(.connectionFailed, "Could not establish the realtime session", underlyingError: error)
        }

        // Before anything else waits: the runtime holds its opening line only
        // for a client that announces "pending" shortly after its pipeline is
        // live. A ready stamp reported while connecting must not be overwritten.
        publishAudioReady(audioReadyStamp ?? WireProtocol.clientAudioReadyPending)
        // The agent's attributes are sticky: an agent that joined before us
        // fires no change event, so read the current values once.
        replayAgentAttributes()
        if microphone {
            try await room.setMicrophoneEnabled(true)
            sdkLog.debug("microphone published")
        }
    }

    /// iOS: `connect` returns with the room already connected. A room that is
    /// not (Android's behaves that way) is waited for, up to a limit.
    private func waitUntilConnected() async throws {
        if room.state == .connected { return }
        if room.state == .disconnected {
            throw FishAgentError(.connectionFailed, "The room disconnected while joining")
        }
        var timeout: ScheduledWork?
        defer { timeout?.cancel() }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connected = continuation
            timeout = scheduler.schedule(afterMilliseconds: roomConnectedTimeoutMs) { [weak self] in
                self?.resumeConnected(throwing: FishAgentError(.connectionFailed, "Could not establish the realtime session"))
            }
        }
    }

    private func resumeConnected(throwing error: Error? = nil) {
        guard let continuation = connected else { return }
        connected = nil
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    }

    func disconnect() async throws {
        cancelGraces()
        delegate = nil
        room.listener = nil
        streams.removeAll()
        resumeConnected(throwing: FishAgentError(.connectionFailed, "The session was ended while joining"))
        await room.disconnect()
    }

    func setMicEnabled(_ enabled: Bool) async throws {
        try await room.setMicrophoneEnabled(enabled)
    }

    func sendClientEvent(_ message: JSONValue) async throws {
        guard delegate != nil, room.state != .disconnected else {
            throw FishAgentError(.connectionFailed, "Session is not connected")
        }
        try await room.publishData(try message.encoded(), topic: WireProtocol.clientEventTopic)
    }

    // MARK: - RoomListener

    func roomDidConnect() {
        resumeConnected()
    }

    func roomDidStartReconnecting() {
        cancelGraces()
        report(.reconnecting)
    }

    func roomDidReconnect() {
        agentLeftGrace?.cancel()
        agentLeftGrace = nil
        // A full reconnect drops the local attributes on the server; set the same value again.
        publishAudioReady(audioReadyStamp ?? WireProtocol.clientAudioReadyPending)
        report(.connected)
        if room.remoteParticipantCount > 0 {
            replayAgentAttributes()
            return
        }
        // The roster can still be empty here even though the agent is in the
        // room. Give it a moment before deciding the agent hung up while we
        // were away. Its attributes are read when it reappears.
        rosterGrace = scheduler.schedule(afterMilliseconds: rosterGraceMs) { [weak self] in
            guard let self else { return }
            self.rosterGrace = nil
            if self.room.state == .connected, self.room.remoteParticipantCount == 0 {
                self.handleAgentLeft()
            }
        }
    }

    func roomDidDisconnect(reason: String) {
        resumeConnected(throwing: FishAgentError(.connectionFailed, "The room disconnected while joining (\(reason))"))
        report(.disconnected, reason: reason)
    }

    func roomParticipantDidConnect(attributes: [String: String]) {
        cancelGraces()
        // A participant that joins already carrying its sticky attributes fires no attribute change.
        handleAgentAttributes(attributes)
    }

    func roomParticipantDidDisconnect() {
        // iOS: this arrives while the room still reads connected and the
        // roster still counts the participant, a millisecond before the
        // disconnect or reconnect that explains it. It also fires during any
        // teardown. So nothing is decided here: after a short wait, the agent
        // has left only if the room is still connected and nobody is in it.
        guard agentLeftGrace == nil, rosterGrace == nil, !ended else { return }
        agentLeftGrace = scheduler.schedule(afterMilliseconds: agentLeftGraceMs) { [weak self] in
            guard let self else { return }
            self.agentLeftGrace = nil
            if self.room.state == .connected, self.room.remoteParticipantCount == 0 {
                self.handleAgentLeft()
            }
        }
    }

    func roomAttributesDidChange(isLocal: Bool, attributes: [String: String]) {
        if !isLocal { handleAgentAttributes(attributes) }
    }

    func roomDidSubscribeAudioTrack(isMicrophoneSource: Bool) {
        // Native WebRTC plays a subscribed track by itself, with no autoplay
        // gate. The agent's speech is its microphone-source track; any other
        // track (background ambience) says nothing about the voice.
        guard isMicrophoneSource, audioReadyStamp == nil else { return }
        let stamp = String(now())
        audioReadyStamp = stamp
        sdkLog.debug("agent voice track subscribed, reporting audio readiness \(stamp, privacy: .public)")
        publishAudioReady(stamp)
    }

    func roomDidReceiveData(topic: String, payload: Data) {
        // After a reconnect our own reliable packets can come back on
        // `client-event` (seen on Android). Only the agent's topic is handled.
        guard topic == WireProtocol.agentEventTopic else { return }
        guard let message = try? JSONValue(data: payload), message["type"]?.stringValue != nil else { return }
        delegate?.transportDidReceiveAgentEvent(message)
    }

    // Both sides' transcripts arrive on LiveKit text streams. Agent segments
    // are one stream of deltas that follows playback, final when the stream
    // closes (an interrupted reply closes holding only what was spoken). User
    // segments are sent again in full on every update, each with an explicit
    // final attribute, on behalf of the user: the sender's identity tells the role.
    func roomTextStreamDidOpen(streamId: String, topic: String, fromLocalIdentity: Bool, attributes: [String: String]) {
        guard topic == WireProtocol.transcriptionTopic else { return }
        guard let segmentId = attributes[WireProtocol.segmentIdAttribute], !segmentId.isEmpty else { return }
        streams[streamId] = TextStream(
            segmentId: segmentId,
            role: fromLocalIdentity ? .user : .agent,
            finalAttribute: attributes[WireProtocol.transcriptionFinalAttribute] == "true"
        )
    }

    func roomTextStreamDidReceive(streamId: String, text: String) {
        guard var stream = streams[streamId] else { return }
        stream.text += text
        streams[streamId] = stream
        delegate?.transportDidReceiveTranscription(
            TranscriptionSegmentUpdate(segmentId: stream.segmentId, role: stream.role, text: stream.text, isFinal: false)
        )
    }

    func roomTextStreamDidClose(streamId: String, aborted: Bool) {
        guard let stream = streams.removeValue(forKey: streamId), !stream.text.isEmpty else { return }
        let isFinal = stream.role == .agent ? true : stream.finalAttribute && !aborted
        delegate?.transportDidReceiveTranscription(
            TranscriptionSegmentUpdate(segmentId: stream.segmentId, role: stream.role, text: stream.text, isFinal: isFinal)
        )
    }

    // MARK: - Internals

    private func cancelGraces() {
        rosterGrace?.cancel()
        rosterGrace = nil
        agentLeftGrace?.cancel()
        agentLeftGrace = nil
    }

    private func report(_ state: TransportConnectionState, reason: String? = nil) {
        guard !ended else { return }
        if state == .disconnected {
            ended = true
            cancelGraces()
        }
        delegate?.transportDidChangeConnectionState(state, reason: reason)
    }

    private func handleAgentLeft() {
        report(.disconnected, reason: DisconnectReasons.agentLeft)
        Task { @MainActor [room] in await room.disconnect() }
    }

    private func replayAgentAttributes() {
        for attributes in room.remoteParticipantAttributes() { handleAgentAttributes(attributes) }
    }

    /// iOS: when a participant leaves, its attributes are reported once more
    /// with empty values. An empty value is the same as no value.
    private func handleAgentAttributes(_ attributes: [String: String]) {
        sdkLog.debug("agent attributes \(attributes.filter { $0.key == WireProtocol.agentReadyAttribute || $0.key == WireProtocol.agentStateAttribute }, privacy: .public)")
        if let ready = attributes[WireProtocol.agentReadyAttribute], !ready.isEmpty {
            delegate?.transportDidSeeAgentReady()
        }
        if let state = attributes[WireProtocol.agentStateAttribute], !state.isEmpty {
            delegate?.transportDidSeeAgentState(state)
        }
    }

    /// Best effort: the runtime's wait is bounded, so a lost report only costs
    /// the handshake. The ready stamp also goes out as a data message, because
    /// LiveKit holds attribute updates from a participant with no published
    /// track (a call started with the microphone off) for seconds.
    private func publishAudioReady(_ value: String) {
        // iOS: setting attributes waits for the server's answer. The updates
        // are chained so "pending" can never land after the ready stamp.
        let previous = attributeUpdates
        attributeUpdates = Task { @MainActor [room] in
            await previous?.value
            do {
                try await room.setLocalAttributes([WireProtocol.clientAudioReadyAttribute: value])
                sdkLog.debug("audio readiness attribute set to \(value, privacy: .public)")
            } catch {
                sdkLog.debug("Setting the audio readiness attribute failed: \(String(describing: error), privacy: .public)")
            }
        }
        guard value != WireProtocol.clientAudioReadyPending, let at = Int64(value) else { return }
        Task { @MainActor [room] in
            do {
                try await room.publishData(try ClientMessages.audioReady(atEpochMs: at).encoded(), topic: WireProtocol.clientEventTopic)
                sdkLog.debug("audio readiness message sent")
            } catch {
                sdkLog.debug("Sending the audio readiness report failed: \(String(describing: error), privacy: .public)")
            }
        }
    }
}
