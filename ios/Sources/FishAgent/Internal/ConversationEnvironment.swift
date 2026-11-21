import Foundation

/// Everything `Conversation` needs from the device. Tests replace it; the app
/// gets `AppleEnvironment`.
@MainActor
protocol ConversationEnvironment: AnyObject, Sendable {
    var scheduler: Scheduler { get }
    var tokens: SessionTokenResolver { get }

    /// Whether the app may use the microphone, asking the user first if they have not been asked yet.
    func requestMicrophonePermission() async -> Bool
    /// A fresh transport for one call.
    func makeTransport() -> Transport
    /// Routes call audio. `callActive` says whether a call is running right now.
    func applyAudioOutput(_ route: AudioOutputRoute, callActive: Bool)
    /// The call is over and its room is gone: put the app's audio back the way it was.
    func callDidEnd()
}

/// One call per process. The audio session is process-wide: two calls at once
/// would reset each other's audio.
@MainActor
enum CallSlot {
    private static var owner: ObjectIdentifier?

    /// True when `candidate` holds the slot afterwards (it was free, or already theirs).
    static func claim(_ candidate: AnyObject) -> Bool {
        let id = ObjectIdentifier(candidate)
        if owner == nil || owner == id {
            owner = id
            return true
        }
        return false
    }

    static func release(_ candidate: ObjectIdentifier) {
        if owner == candidate { owner = nil }
    }

    /// For tests: the slot is process-wide and would otherwise leak from one test into the next.
    static func clearForTests() { owner = nil }
}
