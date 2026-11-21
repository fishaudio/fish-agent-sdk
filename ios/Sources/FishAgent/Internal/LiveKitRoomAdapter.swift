import Foundation
import LiveKit

/// The real room: LiveKit's Swift SDK behind `RoomAdapter`. It holds no logic
/// of its own, only translation, because nothing here runs in unit tests.
/// LiveKit types must not leave this file.
///
/// One adapter serves one call and is not reused after `disconnect()`.
@MainActor
final class LiveKitRoomAdapter: NSObject, RoomAdapter {
    weak var listener: RoomListener?

    private let room = Room()
    /// LiveKit calls its delegate and stream handlers from its own threads.
    /// Everything goes through this one stream to the main actor, so the
    /// order LiveKit delivered things in is the order the listener sees.
    private let facts: AsyncStream<@MainActor @Sendable (RoomListener) -> Void>
    private let post: AsyncStream<@MainActor @Sendable (RoomListener) -> Void>.Continuation
    private var pump: Task<Void, Never>?
    private var handlerRegistered = false

    override init() {
        (facts, post) = AsyncStream.makeStream()
        super.init()
        room.add(delegate: self)
        pump = Task { @MainActor [weak self, facts] in
            for await fact in facts {
                guard let self, let listener = self.listener else { continue }
                fact(listener)
            }
        }
    }

    var state: RoomState {
        switch room.connectionState {
        case .connecting: return .connecting
        case .connected: return .connected
        case .reconnecting: return .reconnecting
        case .disconnected, .disconnecting: return .disconnected
        @unknown default: return .disconnected
        }
    }

    var remoteParticipantCount: Int { room.remoteParticipants.count }

    func remoteParticipantAttributes() -> [[String: String]] {
        room.remoteParticipants.values.map(\.attributes)
    }

    func connect(url: String, token: String) async throws {
        if !handlerRegistered {
            handlerRegistered = true
            let post = post
            let room = room
            try await room.registerTextStreamHandler(for: WireProtocol.transcriptionTopic) { reader, sender in
                let streamId = reader.info.id
                let topic = reader.info.topic
                let attributes = reader.info.attributes
                let fromLocal = sender == room.localParticipant.identity
                post.yield { $0.roomTextStreamDidOpen(streamId: streamId, topic: topic, fromLocalIdentity: fromLocal, attributes: attributes) }
                var aborted = false
                do {
                    for try await chunk in reader {
                        post.yield { $0.roomTextStreamDidReceive(streamId: streamId, text: chunk) }
                    }
                } catch {
                    // Ended abnormally; what arrived is what was spoken.
                    aborted = true
                }
                let wasAborted = aborted
                post.yield { $0.roomTextStreamDidClose(streamId: streamId, aborted: wasAborted) }
            }
        }
        try await room.connect(url: url, token: token)
    }

    func disconnect() async {
        await room.disconnect()
    }

    func setLocalAttributes(_ attributes: [String: String]) async throws {
        try await room.localParticipant.set(attributes: attributes)
    }

    func publishData(_ payload: Data, topic: String) async throws {
        try await room.localParticipant.publish(data: payload, options: DataPublishOptions(topic: topic, reliable: true))
    }

    func setMicrophoneEnabled(_ enabled: Bool) async throws {
        do {
            try await room.localParticipant.setMicrophone(enabled: enabled)
        } catch let error as LiveKitError where error.type == .deviceAccessDenied {
            throw FishAgentError(.micPermissionDenied, "The microphone permission is not granted", underlyingError: error)
        }
    }

    /// LiveKit's reason for a disconnect, as the names the session acts on where one applies.
    fileprivate nonisolated static func reason(for error: LiveKitError?) -> String {
        guard let error else { return "CLIENT_INITIATED" }
        switch error.type {
        case .roomDeleted: return DisconnectReasons.roomDeleted
        default: return String(describing: error.type)
        }
    }
}

extension LiveKitRoomAdapter: RoomDelegate {
    nonisolated func room(_: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        // Reconnects have their own callbacks; this one is only for the first connection.
        if connectionState == .connected, oldConnectionState == .connecting {
            post.yield { $0.roomDidConnect() }
        }
    }

    nonisolated func room(_: Room, didStartReconnectWithMode _: ReconnectMode) {
        post.yield { $0.roomDidStartReconnecting() }
    }

    nonisolated func room(_: Room, didCompleteReconnectWithMode _: ReconnectMode) {
        post.yield { $0.roomDidReconnect() }
    }

    nonisolated func room(_: Room, didDisconnectWithError error: LiveKitError?) {
        let reason = LiveKitRoomAdapter.reason(for: error)
        post.yield { $0.roomDidDisconnect(reason: reason) }
    }

    nonisolated func room(_: Room, participantDidConnect participant: RemoteParticipant) {
        let attributes = participant.attributes
        post.yield { $0.roomParticipantDidConnect(attributes: attributes) }
    }

    nonisolated func room(_: Room, participantDidDisconnect _: RemoteParticipant) {
        post.yield { $0.roomParticipantDidDisconnect() }
    }

    nonisolated func room(_: Room, participant: Participant, didUpdateAttributes attributes: [String: String]) {
        let isLocal = participant is LocalParticipant
        post.yield { $0.roomAttributesDidChange(isLocal: isLocal, attributes: attributes) }
    }

    nonisolated func room(_: Room, participant _: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) {
        guard publication.kind == .audio else { return }
        let isMicrophone = publication.source == .microphone
        post.yield { $0.roomDidSubscribeAudioTrack(isMicrophoneSource: isMicrophone) }
    }

    nonisolated func room(_: Room, participant _: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String, encryptionType _: EncryptionType) {
        post.yield { $0.roomDidReceiveData(topic: topic, payload: data) }
    }
}
