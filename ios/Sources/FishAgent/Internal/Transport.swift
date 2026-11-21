import Foundation

// The seam between the session and the realtime connection. The session speaks
// only these protocols, so LiveKit vocabulary stops at the implementation and
// the session is tested against a fake. Not part of the public API.
// Port of packages/client/src/transport/types.ts, without its browser-only parts.

enum TransportConnectionState: Sendable {
    case connected
    case reconnecting
    case disconnected
}

/// Reasons a transport gives with `.disconnected` that the session acts on.
enum DisconnectReasons {
    /// The agent participant left while the room stayed open.
    static let agentLeft = "AGENT_LEFT"
    static let roomDeleted = "ROOM_DELETED"
    static let roomClosed = "ROOM_CLOSED"
}

/// One update of a transcript segment. `text` is the whole segment so far: updates replace, never append.
struct TranscriptionSegmentUpdate: Sendable {
    let segmentId: String
    let role: MessageRole
    let text: String
    let isFinal: Bool
}

/// Called by the transport, on the main actor, one at a time, in the order things happened.
@MainActor
protocol TransportDelegate: AnyObject {
    /// One message from the `agent-event` topic, already parsed.
    func transportDidReceiveAgentEvent(_ message: JSONValue)
    /// The agent set `fish.agent.ready`. Sticky: a client that joins late still gets it.
    func transportDidSeeAgentReady()
    /// The agent's `lk.agent.state`. Sticky. Proves the agent joined, not that it is ready.
    func transportDidSeeAgentState(_ state: String)
    func transportDidReceiveTranscription(_ update: TranscriptionSegmentUpdate)
    func transportDidChangeConnectionState(_ state: TransportConnectionState, reason: String?)
}

@MainActor
protocol Transport: AnyObject {
    /// Joins the session. Returns once the room is connected and, when
    /// `microphone` is set, the microphone is published. The transport also
    /// reports audio readiness to the runtime by itself (see docs/protocol.md,
    /// section 2): the session has no part in that handshake.
    func connect(sessionToken: SessionToken, delegate: TransportDelegate, microphone: Bool) async throws
    func disconnect() async throws
    func setMicEnabled(_ enabled: Bool) async throws
    /// Sends one message on `client-event`, reliably. Throws when it cannot be sent.
    func sendClientEvent(_ message: JSONValue) async throws
}

/// Something scheduled that can be called off.
@MainActor
protocol ScheduledWork: AnyObject {
    func cancel()
}

/// Timers. Injected so tests can move time by hand.
@MainActor
protocol Scheduler: AnyObject {
    /// Runs `action` on the main actor after `milliseconds`, unless cancelled first.
    func schedule(afterMilliseconds milliseconds: Int, _ action: @escaping @MainActor () -> Void) -> ScheduledWork
}

/// The real clock: a sleeping task per timer.
@MainActor
final class TaskScheduler: Scheduler {
    private final class Work: ScheduledWork {
        var task: Task<Void, Never>?
        func cancel() { task?.cancel() }
    }

    func schedule(afterMilliseconds milliseconds: Int, _ action: @escaping @MainActor () -> Void) -> ScheduledWork {
        let work = Work()
        work.task = Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(max(0, milliseconds)) * 1_000_000)
            if !Task.isCancelled { action() }
        }
        return work
    }
}
