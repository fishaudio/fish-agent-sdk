package com.fishaudio.agent

/** Where a conversation is in its life. `IDLE` is before the first call and after a failed start. */
public enum class ConversationStatus {
    IDLE,
    CONNECTING,
    CONNECTED,

    /** The network dropped and the connection is being restored. Nothing flows until it is back. */
    RECONNECTING,
    ENDED,
}

/** What the agent is doing. */
public enum class AgentMode {
    LISTENING,
    THINKING,
    SPEAKING,
}

/**
 * Why the call ended. [CONNECTION_LOST] is worked out by the SDK (the
 * connection could not be restored, the agent never joined, or the call
 * dropped before the runtime could say why). Every other value is the
 * runtime's own reason, the same one the session record on your backend shows.
 *
 * New reasons can be added in a minor release, so keep an `else` branch when
 * switching over them.
 */
public enum class EndReason(public val wireValue: String) {
    USER_HANGUP("user_hangup"),
    AGENT_HANGUP("agent_hangup"),
    CONVERSATION_TIMEOUT("conversation_timeout"),
    ESCALATED("escalated"),

    /** The agent's custom LLM endpoint failed repeatedly and the runtime closed the session. */
    LLM_ENDPOINT_FAILURE("llm_endpoint_failure"),

    /** The runtime itself failed and closed the session. */
    INTERNAL_ERROR("internal_error"),
    CONNECTION_LOST("connection_lost"),
    ;

    internal companion object {
        /** The reasons a runtime can announce; `connection_lost` is never announced. */
        fun announced(value: String?): EndReason? =
            entries.firstOrNull { it != CONNECTION_LOST && it.wireValue == value }
    }
}

/** Who said something. */
public enum class MessageRole {
    USER,
    AGENT,
}

/**
 * Where a tool call runs. The known values are constants on the companion; a
 * runtime newer than this SDK may send others, which are passed through.
 */
public class ToolCallSource(public val value: String) {
    override fun equals(other: Any?): Boolean = other is ToolCallSource && other.value == value
    override fun hashCode(): Int = value.hashCode()
    override fun toString(): String = value

    public companion object {
        /** A tool the app registered with this SDK. */
        public val CLIENT: ToolCallSource = ToolCallSource("client")
        public val WEBHOOK: ToolCallSource = ToolCallSource("webhook")
        public val MCP: ToolCallSource = ToolCallSource("mcp")
        public val BUILTIN: ToolCallSource = ToolCallSource("builtin")

        /** A call the agent handed to a background task. */
        public val BACKGROUND: ToolCallSource = ToolCallSource("background")

        /** A call the runtime could not resolve; it is reported as a failure. */
        public val UNKNOWN: ToolCallSource = ToolCallSource("unknown")
    }
}

/** One transcript segment. [text] is the whole segment so far and is refined in place. */
public data class TranscriptSegment(
    val segmentId: String,
    val role: MessageRole,
    val text: String,
    val isFinal: Boolean,
)

/** Something that happened in a conversation. State (status, mode, mute) is better read from the flows. */
public sealed interface ConversationEvent {
    /** The call is connected. The agent may still be joining. */
    public data class Connect(val sessionId: String) : ConversationEvent

    /** The call ended. */
    public data class Disconnect(val reason: EndReason) : ConversationEvent

    public data class StatusChange(val status: ConversationStatus) : ConversationEvent

    public data class ModeChange(val mode: AgentMode) : ConversationEvent

    /** The user's speech as recognized so far. Updates for one [segmentId] replace each other. */
    public data class UserTranscript(val segmentId: String, val text: String, val isFinal: Boolean) : ConversationEvent

    /** A piece of the agent's reply. [text] is the segment so far, [delta] what this update added. */
    public data class AgentResponseDelta(val segmentId: String, val delta: String, val text: String) : ConversationEvent

    /** The agent finished a reply. If it was interrupted, [text] is what was spoken. */
    public data class AgentResponse(val segmentId: String, val text: String) : ConversationEvent

    /** A finished message from either side, in conversation order. Enough for a chat log. */
    public data class Message(val role: MessageRole, val text: String) : ConversationEvent

    /**
     * The agent started a tool call. [callId] pairs it with one
     * [ToolCallCompleted] or [ToolCallFailed]. [input] is the arguments as a
     * JSON string; parse it only when [inputTruncated] is false.
     */
    public data class ToolCallStarted(
        val callId: String,
        val toolName: String,
        val source: ToolCallSource,
        val input: String,
        val inputTruncated: Boolean,
    ) : ConversationEvent

    /** [output] is the result as a JSON string; parse it only when [outputTruncated] is false. */
    public data class ToolCallCompleted(
        val callId: String,
        val toolName: String,
        val source: ToolCallSource,
        val output: String,
        val outputTruncated: Boolean,
    ) : ConversationEvent

    /** [httpStatus] is set when the tool's endpoint answered with a failing status. */
    public data class ToolCallFailed(
        val callId: String,
        val toolName: String,
        val source: ToolCallSource,
        val error: String,
        val httpStatus: Int?,
    ) : ConversationEvent

    /** Something failed. It does not by itself mean the call ended; [Disconnect] says that. */
    public data class Error(val error: FishAgentError) : ConversationEvent
}
