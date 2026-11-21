package com.fishaudio.agent.internal

import android.util.Log
import com.fishaudio.agent.AgentMode
import com.fishaudio.agent.ClientToolHandler
import com.fishaudio.agent.ConversationEvent
import com.fishaudio.agent.ConversationStatus
import com.fishaudio.agent.EndReason
import com.fishaudio.agent.FishAgentError
import com.fishaudio.agent.FishAgentErrorCode
import com.fishaudio.agent.FishAgentErrorStage
import com.fishaudio.agent.MessageRole
import com.fishaudio.agent.SessionAuth
import com.fishaudio.agent.SessionOptions
import com.fishaudio.agent.SessionToken
import com.fishaudio.agent.ToolCallSource
import com.fishaudio.agent.TranscriptSegment
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.plus
import kotlinx.serialization.json.JsonObject

/** How long after connecting the agent gets to show up. Normal joins land within a couple of seconds. */
internal const val AGENT_JOIN_TIMEOUT_MS = 15_000L

/**
 * The agent's state is published seconds before its ready signal, so a state
 * alone only proves the agent joined. Queued messages wait this long for the
 * ready signal before treating the agent as an older runtime that never sends one.
 */
internal const val AGENT_READY_FALLBACK_MS = 8_000L

/**
 * The runtime tears the room down right after announcing `session.ended`. If
 * that never lands, end locally with the announced reason.
 */
internal const val SESSION_ENDED_GRACE_MS = 10_000L

private const val TAG = "FishAgent"

/** Everything a session needs from outside itself. Tests replace all of it. */
internal class SessionDependencies(
    val createTransport: () -> Transport,
    val tokens: SessionTokenResolver,
    /**
     * Where the session runs. Single-threaded (the main dispatcher in an app):
     * every call into the session and every transport callback happens here,
     * so the session needs no locks.
     */
    val scope: CoroutineScope,
    /** Receives every event, synchronously, in order. */
    val onEvent: (ConversationEvent) -> Unit,
)

/**
 * One call: the state machine between the app-facing `Conversation` and the
 * transport. Port of packages/client/src/session/agentSession.ts, which is the
 * reference; behaviour written down in docs/protocol.md is followed to the letter.
 */
internal class AgentSession private constructor(
    val sessionId: String,
    private val transport: Transport,
    outerScope: CoroutineScope,
    private val onEvent: (ConversationEvent) -> Unit,
) {
    // A supervisor of its own: one failed send or hangup must not cancel the
    // caller's scope or the session's other work. Completed when the session ends.
    private val supervisor = SupervisorJob(outerScope.coroutineContext.job)
    private val scope: CoroutineScope = outerScope + supervisor

    var status: ConversationStatus = ConversationStatus.CONNECTING
        private set
    var mode: AgentMode = AgentMode.LISTENING
        private set
    var micMuted: Boolean = false
        private set
    var endReason: EndReason? = null
        private set

    /** Reason announced by the runtime over `session.ended`, held until the transport disconnects. */
    private var announcedEndReason: EndReason? = null
    private var endedGraceTimer: Job? = null
    private var endedByClient = false
    private var ending: Deferred<Unit>? = null

    private lateinit var tools: ClientToolDispatcher

    /** Tool handlers and their replies. Cancelled when the session ends. */
    private val toolScope: CoroutineScope = scope + SupervisorJob(supervisor)

    /** Text already delivered per agent segment, to work out deltas from full-text updates. */
    private val agentSegments = HashMap<String, String>()
    private val transcript = ArrayList<TranscriptSegment>()
    private val transcriptIndex = HashMap<String, Int>()
    private var typedMessageCount = 0

    // Data packets reach only participants already in the room, and the agent
    // registers its handlers while it starts up. So typed messages wait here
    // until the agent announces itself: its ready signal, or for older
    // runtimes its first state followed by AGENT_READY_FALLBACK_MS without one.
    private var agentPresent = false

    /** The agent participant is in the room (any state seen), ready or not. */
    private var agentJoined = false
    private val pendingMessages = ArrayList<JsonObject>()
    private var joinTimer: Job? = null
    private var readyFallbackTimer: Job? = null

    val isSpeaking: Boolean get() = mode == AgentMode.SPEAKING

    /** Every transcript segment so far, in conversation order. */
    fun getTranscript(): List<TranscriptSegment> = transcript.toList()

    // ---- text and control ----

    /** Typed turns get a text-only reply unless [audio] is true. */
    fun sendUserMessage(text: String, audio: Boolean = false) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        val message = ClientMessages.userMessage(trimmed, audio)
        if (agentPresent) sendClientEvent(message) else pendingMessages.add(message)
        recordTypedUserMessage(trimmed)
    }

    fun sendUserActivity() = sendClientEvent(ClientMessages.userActivity())

    fun interrupt() = sendClientEvent(ClientMessages.userInterrupt())

    fun registerClientTool(name: String, handler: ClientToolHandler) = tools.register(name, handler)

    // ---- audio ----

    /** After a start without the microphone, the first unmute captures and publishes it. */
    suspend fun setMicMuted(muted: Boolean) {
        val previous = micMuted
        micMuted = muted
        try {
            transport.setMicEnabled(!muted)
        } catch (cancelled: CancellationException) {
            micMuted = previous
            throw cancelled
        } catch (error: Throwable) {
            micMuted = previous
            throw error as? FishAgentError
                ?: FishAgentError(FishAgentErrorCode.CONNECTION_FAILED, "Could not toggle the microphone", cause = error)
        }
    }

    // ---- lifecycle ----

    /** Hangs up. Safe to call more than once: concurrent calls share one hangup. */
    suspend fun end() {
        ending?.let { return it.await() }
        if (status == ConversationStatus.ENDED) return
        val attempt = scope.async { endOnce() }
        ending = attempt
        try {
            attempt.await()
        } catch (error: Throwable) {
            // A failed teardown can be tried again.
            if (ending === attempt) ending = null
            throw error
        }
    }

    private suspend fun endOnce() {
        endedByClient = true
        try {
            // A graceful hangup; the participant leaving is the runtime's fallback if this is lost.
            transport.sendClientEvent(ClientMessages.userHangup())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            // best effort
        }
        transport.disconnect()
        finalize(EndReason.USER_HANGUP)
    }

    // ---- internals ----

    private fun emit(event: ConversationEvent) {
        try {
            onEvent(event)
        } catch (error: Throwable) {
            // One bad listener must not break the session.
            Log.w(TAG, "An event listener threw", error)
        }
    }

    private fun sendClientEvent(message: JsonObject) {
        scope.launch {
            try {
                transport.sendClientEvent(message)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                emit(
                    ConversationEvent.Error(
                        FishAgentError(FishAgentErrorCode.CONNECTION_FAILED, "Failed to send to the agent", cause = error),
                    ),
                )
            }
        }
    }

    private fun setStatus(next: ConversationStatus) {
        if (status != next) {
            status = next
            emit(ConversationEvent.StatusChange(next))
        }
    }

    private fun setMode(next: AgentMode) {
        if (mode != next) {
            mode = next
            emit(ConversationEvent.ModeChange(next))
        }
    }

    private fun handleAgentPresent() {
        if (agentPresent) return
        agentPresent = true
        agentJoined = true
        clearAgentTimers()
        val pending = pendingMessages.toList()
        pendingMessages.clear()
        pending.forEach(::sendClientEvent)
    }

    private fun handleAgentJoined() {
        if (agentJoined) return
        agentJoined = true
        joinTimer?.cancel()
        joinTimer = null
        if (!agentPresent && status != ConversationStatus.ENDED) {
            readyFallbackTimer = scope.launch {
                delay(AGENT_READY_FALLBACK_MS)
                readyFallbackTimer = null
                if (status != ConversationStatus.ENDED) handleAgentPresent()
            }
        }
    }

    private fun clearAgentTimers() {
        joinTimer?.cancel()
        joinTimer = null
        readyFallbackTimer?.cancel()
        readyFallbackTimer = null
    }

    private fun abandonAgentWait() {
        if (status == ConversationStatus.ENDED || agentPresent || agentJoined) return
        emit(
            ConversationEvent.Error(
                FishAgentError(FishAgentErrorCode.CONNECTION_FAILED, "The agent did not join the session"),
            ),
        )
        disconnectQuietly()
        finalize(EndReason.CONNECTION_LOST)
    }

    /** Leaves the room without waiting and without reporting a failure: the session is ending anyway. */
    private fun disconnectQuietly() {
        scope.launch {
            try {
                transport.disconnect()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
            }
        }
    }

    private fun handleConnectionState(state: TransportConnectionState, reason: String?) {
        if (status == ConversationStatus.ENDED) return
        when (state) {
            TransportConnectionState.RECONNECTING -> setStatus(ConversationStatus.RECONNECTING)
            TransportConnectionState.CONNECTED ->
                if (status == ConversationStatus.RECONNECTING) setStatus(ConversationStatus.CONNECTED)
            TransportConnectionState.DISCONNECTED -> {
                // In order of priority (docs/protocol.md, section 7): the user
                // hung up; the runtime announced why; otherwise a guess from
                // the transport. Without an announcement, an agent that left
                // and a deleted room cannot be told apart and both read as
                // agent_hangup; anything else is connection_lost.
                val ended = when {
                    endedByClient -> EndReason.USER_HANGUP
                    announcedEndReason != null -> announcedEndReason!!
                    reason == DisconnectReasons.AGENT_LEFT ||
                        reason == DisconnectReasons.ROOM_DELETED ||
                        reason == DisconnectReasons.ROOM_CLOSED -> EndReason.AGENT_HANGUP
                    else -> EndReason.CONNECTION_LOST
                }
                finalize(ended)
            }
        }
    }

    private fun finalize(reason: EndReason) {
        if (status == ConversationStatus.ENDED) return
        clearAgentTimers()
        endedGraceTimer?.cancel()
        endedGraceTimer = null
        toolScope.cancel()
        // Work already started (a hangup in flight) finishes; nothing new starts.
        supervisor.complete()
        endReason = reason
        setStatus(ConversationStatus.ENDED)
        emit(ConversationEvent.Disconnect(reason))
    }

    private fun handleSessionEnded(reason: String?) {
        if (status == ConversationStatus.ENDED || announcedEndReason != null) return
        // A reason this SDK does not know voids the announcement; the transport's signals decide instead.
        val announced = EndReason.announced(reason) ?: return
        announcedEndReason = announced
        endedGraceTimer = scope.launch {
            delay(SESSION_ENDED_GRACE_MS)
            endedGraceTimer = null
            disconnectQuietly()
            finalize(announced)
        }
    }

    private fun handleAgentEvent(message: JsonObject) {
        when (message.string("type")) {
            "client_tool.call" -> {
                val call = ClientToolCall(
                    callId = message.string("callId") ?: return dropped(message, "callId"),
                    toolName = message.string("toolName") ?: return dropped(message, "toolName"),
                    params = message["params"] as? JsonObject ?: JsonObject(emptyMap()),
                    expectsResponse = message.boolean("expectsResponse") == true,
                    timeoutMs = message.number("timeoutMs"),
                )
                toolScope.launch { tools.dispatch(call) }
            }
            "tool.started" -> emit(
                ConversationEvent.ToolCallStarted(
                    callId = message.string("callId") ?: return dropped(message, "callId"),
                    toolName = message.string("toolName") ?: return dropped(message, "toolName"),
                    source = toolSource(message),
                    input = message.string("input").orEmpty(),
                    inputTruncated = message.boolean("inputTruncated") == true,
                ),
            )
            "tool.completed" -> emit(
                ConversationEvent.ToolCallCompleted(
                    callId = message.string("callId") ?: return dropped(message, "callId"),
                    toolName = message.string("toolName") ?: return dropped(message, "toolName"),
                    source = toolSource(message),
                    output = message.string("output").orEmpty(),
                    outputTruncated = message.boolean("outputTruncated") == true,
                ),
            )
            "tool.failed" -> emit(
                ConversationEvent.ToolCallFailed(
                    callId = message.string("callId") ?: return dropped(message, "callId"),
                    toolName = message.string("toolName") ?: return dropped(message, "toolName"),
                    source = toolSource(message),
                    error = message.string("error").orEmpty(),
                    httpStatus = message.number("httpStatus")?.toInt(),
                ),
            )
            "session.ended" -> handleSessionEnded(message.string("reason"))
            "error" -> {
                // The message carries a category only; the wording is the SDK's own.
                val provider = message.string("code") == "provider_error"
                val recovered = message.boolean("recovered")
                val base = if (provider) {
                    "An upstream provider failed during the session"
                } else {
                    "The agent runtime hit an internal error"
                }
                emit(
                    ConversationEvent.Error(
                        FishAgentError(
                            code = if (provider) FishAgentErrorCode.PROVIDER_ERROR else FishAgentErrorCode.INTERNAL_ERROR,
                            message = if (recovered == true) "$base, the agent is retrying this turn" else base,
                            stage = FishAgentErrorStage.fromWire(message.string("stage")),
                            recovered = recovered,
                        ),
                    ),
                )
            }
            // Unknown message types are ignored by contract: the protocol only adds things.
            else -> Unit
        }
    }

    private fun toolSource(message: JsonObject): ToolCallSource =
        message.string("toolSource")?.let(::ToolCallSource) ?: ToolCallSource.UNKNOWN

    /** A known message without a field it cannot be handled without. The TypeScript client has no such check. */
    private fun dropped(message: JsonObject, missing: String) {
        Log.d(TAG, "Dropped a ${message.string("type")} message without `$missing`")
    }

    private fun recordSegment(role: MessageRole, segmentId: String, text: String, isFinal: Boolean) {
        val key = "${role.name}:$segmentId"
        val segment = TranscriptSegment(segmentId, role, text, isFinal)
        val index = transcriptIndex[key]
        if (index == null) {
            transcriptIndex[key] = transcript.size
            transcript.add(segment)
        } else {
            transcript[index] = segment
        }
    }

    private fun handleTranscription(update: TranscriptionSegmentUpdate) {
        if (update.role == MessageRole.USER) {
            recordSegment(MessageRole.USER, update.segmentId, update.text, update.isFinal)
            emit(ConversationEvent.UserTranscript(update.segmentId, update.text, update.isFinal))
            if (update.isFinal) emit(ConversationEvent.Message(MessageRole.USER, update.text))
            return
        }
        // Agent text follows playback, so streaming text means the agent is
        // audibly speaking, and the segment closing means it has finished.
        setMode(if (update.isFinal) AgentMode.LISTENING else AgentMode.SPEAKING)
        recordSegment(MessageRole.AGENT, update.segmentId, update.text, update.isFinal)
        val previous = agentSegments[update.segmentId].orEmpty()
        val delta = if (update.text.startsWith(previous)) update.text.substring(previous.length) else update.text
        agentSegments[update.segmentId] = update.text
        if (delta.isNotEmpty()) {
            emit(ConversationEvent.AgentResponseDelta(update.segmentId, delta, update.text))
        }
        if (update.isFinal) {
            agentSegments.remove(update.segmentId)
            emit(ConversationEvent.AgentResponse(update.segmentId, update.text))
            emit(ConversationEvent.Message(MessageRole.AGENT, update.text))
        }
    }

    /** Typed messages are not echoed by the server; the sender shows its own message. */
    private fun recordTypedUserMessage(text: String) {
        val segmentId = "typed_${++typedMessageCount}"
        recordSegment(MessageRole.USER, segmentId, text, isFinal = true)
        emit(ConversationEvent.UserTranscript(segmentId, text, isFinal = true))
        emit(ConversationEvent.Message(MessageRole.USER, text))
    }

    private inner class Callbacks : TransportCallbacks {
        override fun onAgentEvent(message: JsonObject) = handleAgentEvent(message)

        override fun onAgentReady() = handleAgentPresent()

        // "listening" is the default mode; the agent's state supplies the
        // thinking edge; speaking follows the transcript segments.
        override fun onAgentState(state: String) {
            handleAgentJoined()
            if (state == "thinking") setMode(AgentMode.THINKING)
        }

        override fun onTranscription(update: TranscriptionSegmentUpdate) = handleTranscription(update)

        override fun onConnectionState(state: TransportConnectionState, reason: String?) =
            handleConnectionState(state, reason)
    }

    companion object {
        /**
         * Gets a session token if needed, connects and hands back a live
         * session. Throws [FishAgentError] when the session request or the
         * connection fails.
         */
        suspend fun start(auth: SessionAuth, options: SessionOptions, dependencies: SessionDependencies): AgentSession {
            val sessionToken: SessionToken = dependencies.tokens.resolve(auth, options)
            val transport = dependencies.createTransport()
            val session = AgentSession(sessionToken.sessionId, transport, dependencies.scope, dependencies.onEvent)
            if (!options.microphone) session.micMuted = true
            session.tools = ClientToolDispatcher(
                tools = options.clientTools,
                fallbackTimeoutMs = options.clientToolTimeoutMs,
                handlerScope = session.toolScope,
                send = transport::sendClientEvent,
                onError = { session.emit(ConversationEvent.Error(it)) },
            )

            try {
                transport.connect(sessionToken, TransportConnectOptions(session.Callbacks(), options.microphone))
            } catch (error: Throwable) {
                // connect() can fail after the room is joined (the microphone,
                // for one); leave it, or the room stays connected with no owner.
                try {
                    transport.disconnect()
                } catch (_: Throwable) {
                }
                session.finalize(EndReason.CONNECTION_LOST)
                if (error is CancellationException) throw error
                throw error as? FishAgentError
                    ?: FishAgentError(
                        FishAgentErrorCode.CONNECTION_FAILED,
                        "Could not establish the realtime session",
                        cause = error,
                    )
            }

            if (session.status == ConversationStatus.CONNECTING) {
                session.setStatus(ConversationStatus.CONNECTED)
                session.emit(ConversationEvent.Connect(session.sessionId))
            }
            if (!session.agentJoined && session.status == ConversationStatus.CONNECTED) {
                session.joinTimer = session.scope.launch {
                    delay(AGENT_JOIN_TIMEOUT_MS)
                    session.joinTimer = null
                    session.abandonAgentWait()
                }
            }
            return session
        }
    }
}
