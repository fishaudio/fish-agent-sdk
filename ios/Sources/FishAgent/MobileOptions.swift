import Foundation

/// Where the agent's voice plays.
public enum AudioOutputRoute: String, Sendable, CaseIterable {
    /// A connected Bluetooth or wired headset wins; otherwise the loudspeaker.
    case auto
    /// The loudspeaker, even with a headset connected.
    case speaker
    /// The phone's receiver, held to the ear.
    case earpiece
}

/// What a phone needs around a call, on top of `SessionOptions`.
public struct MobileOptions: Sendable {
    /// Where the agent's voice plays when a call starts. Change it during a call with `Conversation.setAudioOutput(_:)`.
    public var audioOutput: AudioOutputRoute

    public init(audioOutput: AudioOutputRoute = .auto) {
        self.audioOutput = audioOutput
    }
}

/// Using a `Conversation` in a way it does not allow.
public enum ConversationUsageError: Error, LocalizedError, Sendable {
    /// Another `Conversation` has a call in progress. Only one call can run in an app at a time.
    case callAlreadyActive

    public var errorDescription: String? {
        switch self {
        case .callAlreadyActive:
            return "Another Conversation has a call in progress. Only one call can run in an app at a time."
        }
    }
}
