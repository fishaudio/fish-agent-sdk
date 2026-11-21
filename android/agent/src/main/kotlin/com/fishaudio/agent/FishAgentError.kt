package com.fishaudio.agent

/**
 * What went wrong. The values are the same as the Web and React Native SDKs';
 * [wireValue] is the code as those SDKs and the documentation spell it.
 *
 * New codes can be added in a minor release, so keep an `else` branch when
 * switching over them.
 */
public enum class FishAgentErrorCode(public val wireValue: String) {
    /** The session request failed: no response, or a status this SDK has no narrower code for. */
    SESSION_REQUEST_FAILED("session_request_failed"),

    /** The agent does not accept sessions without an API key. */
    AGENT_NOT_PUBLIC("agent_not_public"),

    /** The agent restricts origins and the request's origin is not on its list. */
    ORIGIN_FORBIDDEN("origin_forbidden"),

    /** The agent owner's account has no Agent credit left (HTTP 402). */
    INSUFFICIENT_CREDIT("insufficient_credit"),

    /** The session uses a transport this SDK version does not support. Upgrade the SDK. */
    UNSUPPORTED_TRANSPORT("unsupported_transport"),

    /** The microphone permission is not granted. */
    MIC_PERMISSION_DENIED("mic_permission_denied"),

    /** A requested audio device could not be activated. Not raised by this SDK today. */
    DEVICE_CHANGE_FAILED("device_change_failed"),

    /** The realtime connection could not be set up, or a message could not be sent. */
    CONNECTION_FAILED("connection_failed"),

    /** The session token's join deadline has passed. Request a new one. */
    SESSION_EXPIRED("session_expired"),

    /** A client tool failed, is not registered, or its result could not be sent. */
    TOOL_FAILED("tool_failed"),

    /** A client tool did not return in time. */
    TOOL_TIMEOUT("tool_timeout"),

    /** An upstream model or speech provider failed during the session. */
    PROVIDER_ERROR("provider_error"),

    /** The agent runtime hit an internal error. */
    INTERNAL_ERROR("internal_error"),
}

/** Pipeline stage a [FishAgentErrorCode.PROVIDER_ERROR] or [FishAgentErrorCode.INTERNAL_ERROR] came from. */
public enum class FishAgentErrorStage(public val wireValue: String) {
    LLM("llm"),
    STT("stt"),
    TTS("tts"),
    RUNTIME("runtime"),
    ;

    internal companion object {
        fun fromWire(value: String?): FishAgentErrorStage? = entries.firstOrNull { it.wireValue == value }
    }
}

/** Every failure the SDK reports, thrown from calls or delivered as [ConversationEvent.Error]. */
public class FishAgentError(
    public val code: FishAgentErrorCode,
    message: String,
    /** HTTP status of the failing session request, when the error came from there. */
    public val statusCode: Int? = null,
    /** Which stage failed, when the runtime said. Only on provider and internal errors. */
    public val stage: FishAgentErrorStage? = null,
    /**
     * Only on provider and internal errors. `true`: the runtime is still going
     * to answer this turn by itself, so a light hint is enough. `false`: the
     * turn is lost. `null`: the runtime did not say. Never means the session ended.
     */
    public val recovered: Boolean? = null,
    cause: Throwable? = null,
) : Exception(message, cause) {
    override val message: String get() = super.message ?: code.wireValue
}
