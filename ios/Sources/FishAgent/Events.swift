import Foundation

/// Where a conversation is in its life. `idle` is before the first call and after a failed start.
public enum ConversationStatus: String, Sendable, CaseIterable {
    case idle
    case connecting
    case connected
    /// The network dropped and the connection is being restored. Nothing flows until it is back.
    case reconnecting
    case ended
}

/// What the agent is doing.
public enum AgentMode: String, Sendable, CaseIterable {
    case listening
    case thinking
    case speaking
}

/// Why the call ended. `connectionLost` is worked out by the SDK (the
/// connection could not be restored, the agent never joined, or the call
/// dropped before the runtime could say why). Every other value is the
/// runtime's own reason, the same one the session record on your backend shows.
///
/// New reasons can be added in a minor release, so keep a `default` when
/// switching over them.
public enum EndReason: String, Sendable, CaseIterable {
    case userHangup = "user_hangup"
    case agentHangup = "agent_hangup"
    case conversationTimeout = "conversation_timeout"
    case escalated
    /// The agent's custom LLM endpoint failed repeatedly and the runtime closed the session.
    case llmEndpointFailure = "llm_endpoint_failure"
    /// The runtime itself failed and closed the session.
    case internalError = "internal_error"
    case connectionLost = "connection_lost"

    /// The reasons a runtime can announce; `connection_lost` is never announced.
    static func announced(_ value: String?) -> EndReason? {
        guard let value, let reason = EndReason(rawValue: value), reason != .connectionLost else { return nil }
        return reason
    }
}

/// Who said something.
public enum MessageRole: String, Sendable {
    case user
    case agent
}

/// Where a tool call runs. The known values are static members; a runtime
/// newer than this SDK may send others, which are passed through.
public struct ToolCallSource: RawRepresentable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    /// A tool the app registered with this SDK.
    public static let client = ToolCallSource(rawValue: "client")
    public static let webhook = ToolCallSource(rawValue: "webhook")
    public static let mcp = ToolCallSource(rawValue: "mcp")
    public static let builtin = ToolCallSource(rawValue: "builtin")
    /// A call the agent handed to a background task.
    public static let background = ToolCallSource(rawValue: "background")
    /// A call the runtime could not resolve; it is reported as a failure.
    public static let unknown = ToolCallSource(rawValue: "unknown")
}

/// One transcript segment. `text` is the whole segment so far and is refined in place.
public struct TranscriptSegment: Sendable, Hashable {
    public let segmentId: String
    public let role: MessageRole
    public let text: String
    public let isFinal: Bool
}

/// One entry of a chat log. Streaming entries are refined in place under the same `id`.
public struct ChatMessage: Sendable, Hashable, Identifiable {
    /// Stable for one segment.
    public let id: String
    public let role: MessageRole
    public let text: String
    /// False while the segment is still streaming.
    public let isFinal: Bool
}

/// The agent started a tool call. `callId` pairs it with one completed or
/// failed event. `input` is the arguments as a JSON string; parse it only when
/// `inputTruncated` is false.
public struct ToolCallStarted: Sendable, Hashable {
    public let callId: String
    public let toolName: String
    public let source: ToolCallSource
    public let input: String
    public let inputTruncated: Bool
}

/// `output` is the result as a JSON string; parse it only when `outputTruncated` is false.
public struct ToolCallCompleted: Sendable, Hashable {
    public let callId: String
    public let toolName: String
    public let source: ToolCallSource
    public let output: String
    public let outputTruncated: Bool
}

/// `httpStatus` is set when the tool's endpoint answered with a failing status.
public struct ToolCallFailed: Sendable, Hashable {
    public let callId: String
    public let toolName: String
    public let source: ToolCallSource
    public let error: String
    public let httpStatus: Int?
}

/// Something that happened in a conversation. State (status, mode, mute) is
/// better read from the conversation's published properties.
public enum ConversationEvent: Sendable {
    /// The call is connected. The agent may still be joining.
    case connect(sessionId: String)
    /// The call ended.
    case disconnect(reason: EndReason)
    case statusChange(ConversationStatus)
    case modeChange(AgentMode)
    /// The user's speech as recognized so far. Updates for one `segmentId` replace each other.
    case userTranscript(segmentId: String, text: String, isFinal: Bool)
    /// A piece of the agent's reply. `text` is the segment so far, `delta` what this update added.
    case agentResponseDelta(segmentId: String, delta: String, text: String)
    /// The agent finished a reply. If it was interrupted, `text` is what was spoken.
    case agentResponse(segmentId: String, text: String)
    /// A finished message from either side, in conversation order. Enough for a chat log.
    case message(role: MessageRole, text: String)
    case toolCallStarted(ToolCallStarted)
    case toolCallCompleted(ToolCallCompleted)
    case toolCallFailed(ToolCallFailed)
    /// Something failed. It does not by itself mean the call ended; `disconnect` says that.
    case error(FishAgentError)
}
