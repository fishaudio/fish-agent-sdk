import Foundation

// The second seam, below the transport: a LiveKit room reduced to plain facts
// and commands. All of the transport's logic sits above it, where tests drive
// it with event sequences recorded from real calls (see
// Tests/FishAgentTests/Recordings). The real implementation is a thin wrapper
// and is checked on devices.

enum RoomState: String, Sendable {
    case connecting
    case connected
    case reconnecting
    case disconnected
}

/// What the room reports. Every call arrives on the main actor, one at a time,
/// in the order the room delivered things. LiveKit calls its delegate and its
/// text stream handlers from its own threads; the adapter puts them through
/// one queue so that order is kept.
@MainActor
protocol RoomListener: AnyObject {
    func roomDidConnect()
    func roomDidStartReconnecting()
    func roomDidReconnect()
    /// `reason` is a `DisconnectReasons` value where one applies, else a name for logs.
    func roomDidDisconnect(reason: String)
    /// A remote participant joined, with the attributes it already carries.
    func roomParticipantDidConnect(attributes: [String: String])
    func roomParticipantDidDisconnect()
    /// `attributes` holds at least the attributes that changed.
    func roomAttributesDidChange(isLocal: Bool, attributes: [String: String])
    /// A remote audio track is subscribed. `isMicrophoneSource` marks the agent's speech.
    func roomDidSubscribeAudioTrack(isMicrophoneSource: Bool)
    func roomDidReceiveData(topic: String, payload: Data)
    func roomTextStreamDidOpen(streamId: String, topic: String, fromLocalIdentity: Bool, attributes: [String: String])
    func roomTextStreamDidReceive(streamId: String, text: String)
    /// `aborted` is true when the stream ended abnormally; what arrived before still counts.
    func roomTextStreamDidClose(streamId: String, aborted: Bool)
}

@MainActor
protocol RoomAdapter: AnyObject {
    var listener: RoomListener? { get set }
    /// The room's state right now. Read when a fact is handled, not cached.
    var state: RoomState { get }
    var remoteParticipantCount: Int { get }
    /// The attributes of every remote participant in the room. They are sticky: no change event fires for them.
    func remoteParticipantAttributes() -> [[String: String]]

    /// Joins the room.
    func connect(url: String, token: String) async throws
    /// Leaves the room. Safe to call more than once.
    func disconnect() async
    func setLocalAttributes(_ attributes: [String: String]) async throws
    /// Sends one reliable data packet. Throws when it cannot be sent.
    func publishData(_ payload: Data, topic: String) async throws
    /// Captures and publishes the microphone, or mutes it. Throws when it cannot.
    func setMicrophoneEnabled(_ enabled: Bool) async throws
}
