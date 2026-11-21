package com.fishaudio.agent

import android.content.Context
import com.fishaudio.agent.internal.AgentSession
import com.fishaudio.agent.internal.AndroidEnvironment
import com.fishaudio.agent.internal.AudioRouter
import com.fishaudio.agent.internal.CallSlot
import com.fishaudio.agent.internal.ConversationEnvironment
import com.fishaudio.agent.internal.SessionDependencies
import kotlin.coroutines.ContinuationInterceptor
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * A voice conversation with a Fish Audio agent, and what a phone needs around
 * it: audio routing and, for calls with the microphone on, the foreground
 * service that keeps the microphone running in the background.
 *
 * Create one and keep it (in a ViewModel, for example). It can make any number
 * of calls, one at a time. Read state from the flows; [events] tells what
 * happened. Call [close] when you are done with it.
 *
 * ```
 * val conversation = Conversation(context)
 * if (FishAgentPermissions.requestMicrophonePermission(activity)) {
 *     conversation.startSession(SessionAuth.Token(SessionToken.fromJson(responseBody)))
 * }
 * ```
 *
 * Methods can be called from any thread. The work, the flows' updates and
 * client tools run on the main thread.
 *
 * Only one call can run in an app at a time, whichever `Conversation` makes it.
 */
public class Conversation internal constructor(
    private val defaults: SessionOptions,
    private val mobile: MobileOptions,
    private val environment: ConversationEnvironment,
) : AutoCloseable {
    /**
     * @param context any context; only the application context is kept.
     * @param defaults options for every call. [startSession] can adjust them per call.
     */
    public constructor(
        context: Context,
        defaults: SessionOptions = SessionOptions(),
        mobile: MobileOptions = MobileOptions(),
    ) : this(defaults, mobile, AndroidEnvironment(context))

    private val scope = environment.scope
    private val dispatcher = checkNotNull(scope.coroutineContext[ContinuationInterceptor])

    private val _status = MutableStateFlow(ConversationStatus.IDLE)
    private val _mode = MutableStateFlow(AgentMode.LISTENING)
    private val _micMuted = MutableStateFlow(false)
    private val _audioOutput = MutableStateFlow(mobile.audioOutput)
    private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    private val _endReason = MutableStateFlow<EndReason?>(null)
    private val _events = MutableSharedFlow<ConversationEvent>(
        replay = 0,
        extraBufferCapacity = 256,
        onBufferOverflow = BufferOverflow.DROP_OLDEST,
    )

    /** `IDLE` before the first call and after a start that failed. Stays `ENDED` after a call until the next one starts. */
    public val status: StateFlow<ConversationStatus> = _status.asStateFlow()

    public val mode: StateFlow<AgentMode> = _mode.asStateFlow()

    public val micMuted: StateFlow<Boolean> = _micMuted.asStateFlow()

    /** The route that was asked for. It is not the device audio is playing on right now. */
    public val audioOutput: StateFlow<AudioOutputRoute> = _audioOutput.asStateFlow()

    /**
     * The chat log of the current call, streaming entries included (see
     * [ChatMessage.isFinal]). It stays after the call ends and is emptied when
     * the next call starts. For finished messages only, collect
     * [ConversationEvent.Message] from [events].
     */
    public val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

    /** Why the last call ended. `null` during a call and before the first one. */
    public val endReason: StateFlow<EndReason?> = _endReason.asStateFlow()

    /**
     * What happens during calls. Nothing is replayed: an event emitted before
     * you started collecting is gone, so read state from the flows above. A
     * collector that falls more than 256 events behind loses the oldest ones.
     */
    public val events: SharedFlow<ConversationEvent> = _events.asSharedFlow()

    public val isSpeaking: Boolean get() = _mode.value == AgentMode.SPEAKING

    /** The ID of the current or last call's session. */
    public val sessionId: String? get() = session?.sessionId

    /** One call to [startSession] that is still on its way. */
    private class PendingStart {
        lateinit var result: Deferred<String>

        /** [endSession] or [close] ran while this was starting. */
        var cancelled = false

        /** This start's session became the conversation's session. */
        var published = false
    }

    // Everything below is touched on the main dispatcher only.
    private var session: AgentSession? = null
    private var sessionStart: PendingStart? = null
    private var starting: PendingStart? = null

    /** The start whose call holds the audio route and the call service. */
    private var platformOwner: PendingStart? = null
    private var router: AudioRouter? = null
    private var serviceRunning = false
    private var closed = false
    private val tools = LinkedHashMap(defaults.clientTools)

    private val liveSession: AgentSession? get() = session?.takeIf { it.status != ConversationStatus.ENDED }

    /**
     * Starts a call and returns its session ID once it is connected. The agent
     * may still be joining then; messages sent early are held until it is ready.
     *
     * Calling this again while a start is on its way, or while a call is live,
     * joins that call and returns its ID. The start belongs to the
     * conversation, not to the caller: cancelling the calling coroutine stops
     * the wait, not the call. Use [endSession] to hang up.
     *
     * @param configure adjusts [SessionOptions] for this call, starting from the conversation's defaults.
     * @throws FishAgentError when the call cannot be set up. [status] goes back to `IDLE`.
     * @throws ConversationStartCancelledException when [endSession] ran while this was starting.
     * @throws IllegalStateException when another `Conversation` has a call in progress, or after [close].
     */
    public suspend fun startSession(
        auth: SessionAuth,
        configure: (SessionOptions) -> SessionOptions = { it },
    ): String = withContext(dispatcher) { beginStart(auth, configure) }.await()

    private fun beginStart(auth: SessionAuth, configure: (SessionOptions) -> SessionOptions): Deferred<String> {
        check(!closed) { "This Conversation is closed" }
        liveSession?.let { return CompletableDeferred(it.sessionId) }
        val previous = starting
        if (previous != null && !previous.cancelled) return previous.result
        check(CallSlot.claim(this)) {
            "Another Conversation has a call in progress. Only one call can run in an app at a time."
        }
        val configured = configure(defaults)
        // Tools registered on the conversation apply to every call; the per-call options win.
        val options = configured.copy(clientTools = tools + configured.clientTools)

        val pending = PendingStart()
        starting = pending
        _messages.value = emptyList()
        _endReason.value = null
        _status.value = ConversationStatus.CONNECTING
        pending.result = scope.async {
            // A start that was hung up on releases what it holds before the next one begins.
            previous?.result?.join()
            runStart(pending, auth, options)
        }
        return pending.result
    }

    private suspend fun runStart(pending: PendingStart, auth: SessionAuth, options: SessionOptions): String {
        try {
            if (pending.cancelled) throw ConversationStartCancelledException()
            if (options.microphone && !environment.hasMicrophonePermission()) {
                throw FishAgentError(
                    FishAgentErrorCode.MIC_PERMISSION_DENIED,
                    "The microphone permission is not granted. Ask for it first, for example with " +
                        "FishAgentPermissions.requestMicrophonePermission",
                )
            }
            platformOwner = pending
            if (options.microphone) startCallService()
            val started = AgentSession.start(
                auth,
                options,
                SessionDependencies(
                    // Created only once a session token is in hand: a failed session request costs no room.
                    createTransport = {
                        val call = environment.createTransport(_audioOutput.value)
                        if (platformOwner === pending) router = call.router
                        call.transport
                    },
                    tokens = environment.tokens,
                    scope = scope,
                    onEvent = { event -> onSessionEvent(pending, event) },
                ),
            )
            // endSession or close may have run while the session was being
            // set up. That late session never becomes the conversation's: it
            // is closed before it can keep the microphone or the connection.
            if (pending.cancelled) {
                try {
                    started.end()
                } catch (_: Throwable) {
                }
                throw ConversationStartCancelledException()
            }
            session = started
            sessionStart = pending
            pending.published = true
            // Mirror, do not assume: a start without the microphone joins muted.
            _micMuted.value = started.micMuted
            _mode.value = started.mode
            _status.value = started.status
            if (started.status == ConversationStatus.ENDED) {
                // It ended while connecting.
                _endReason.value = started.endReason
                releasePlatform(pending)
            }
            return started.sessionId
        } catch (error: Throwable) {
            releasePlatform(pending)
            if (!pending.cancelled) _status.value = ConversationStatus.IDLE
            throw error
        } finally {
            if (starting === pending) starting = null
        }
    }

    private fun onSessionEvent(pending: PendingStart, event: ConversationEvent) {
        // A start that was hung up on shows nothing of what it still does.
        if (pending.cancelled) return
        when (event) {
            is ConversationEvent.StatusChange ->
                // Before the session is published, an end is a failed start;
                // runStart reports that as IDLE.
                if (pending.published || event.status != ConversationStatus.ENDED) {
                    _status.value = event.status
                    // A call can also end from the other side or the network.
                    if (event.status == ConversationStatus.ENDED) releasePlatform(pending)
                }
            is ConversationEvent.Disconnect -> if (pending.published) _endReason.value = event.reason
            is ConversationEvent.ModeChange -> _mode.value = event.mode
            is ConversationEvent.UserTranscript ->
                upsertMessage("user-${event.segmentId}", MessageRole.USER, event.text, event.isFinal)
            is ConversationEvent.AgentResponseDelta ->
                upsertMessage("agent-${event.segmentId}", MessageRole.AGENT, event.text, false)
            is ConversationEvent.AgentResponse ->
                upsertMessage("agent-${event.segmentId}", MessageRole.AGENT, event.text, true)
            else -> Unit
        }
        _events.tryEmit(event)
    }

    private fun upsertMessage(key: String, role: MessageRole, text: String, isFinal: Boolean) {
        val entry = ChatMessage(key, role, text, isFinal)
        val current = _messages.value
        val index = current.indexOfFirst { it.key == key }
        _messages.value = if (index == -1) current + entry else current.toMutableList().also { it[index] = entry }
    }

    private fun startCallService() {
        val notification = mobile.callNotification ?: return
        if (serviceRunning) return
        serviceRunning = environment.startCallService(notification)
    }

    /** Releases the audio route and the call service, if [owner]'s call still holds them. */
    private fun releasePlatform(owner: PendingStart) {
        if (platformOwner === owner) {
            platformOwner = null
            router = null
            if (serviceRunning) {
                serviceRunning = false
                environment.stopCallService()
            }
        }
        // The slot stays claimed while a newer start of this conversation is on its way.
        val newer = starting?.takeIf { it !== owner }
        if (newer == null && liveSession == null) CallSlot.release(this)
    }

    /**
     * Hangs up. Safe to call at any time, also while a call is still starting:
     * that start then fails with [ConversationStartCancelledException] and its
     * session, if one was created, is closed. Does nothing when there is no call.
     */
    public suspend fun endSession(): Unit = withContext(dispatcher) {
        val pending = starting
        val current = liveSession
        if (pending != null) {
            pending.cancelled = true
            _status.value = ConversationStatus.ENDED
        }
        try {
            current?.end()
        } finally {
            // The cancelled start releases what it holds as it finishes; its failure is its caller's to see.
            pending?.result?.join()
            sessionStart?.let(::releasePlatform)
        }
    }

    /** After a start without the microphone, the first unmute captures it. Does nothing when there is no call. */
    public suspend fun setMicMuted(muted: Boolean): Unit = withContext(dispatcher) {
        val current = liveSession ?: return@withContext
        if (!muted) {
            if (!environment.hasMicrophonePermission()) {
                throw FishAgentError(
                    FishAgentErrorCode.MIC_PERMISSION_DENIED,
                    "The microphone permission is not granted. Ask for it first, for example with " +
                        "FishAgentPermissions.requestMicrophonePermission",
                )
            }
            // A call started without the microphone runs no service; it needs one from here on.
            if (platformOwner === sessionStart) startCallService()
        }
        current.setMicMuted(muted)
        _micMuted.value = muted
    }

    /** Sends a typed message. The agent answers in text only unless [audio] is true. Does nothing when there is no call. */
    public fun sendUserMessage(text: String, audio: Boolean = false) {
        scope.launch { liveSession?.sendUserMessage(text, audio) }
    }

    /** Tells the agent the user is active (typing, for one), so silence is not taken for idleness. */
    public fun sendUserActivity() {
        scope.launch { liveSession?.sendUserActivity() }
    }

    /** Stops the agent's current reply. */
    public fun interrupt() {
        scope.launch { liveSession?.interrupt() }
    }

    /** Changes where the agent's voice plays, now and for later calls. */
    public fun setAudioOutput(route: AudioOutputRoute) {
        scope.launch {
            _audioOutput.value = route
            router?.route(route)
        }
    }

    /** Registers a client tool for the current call and every later one. */
    public fun registerClientTool(name: String, handler: ClientToolHandler) {
        scope.launch {
            tools[name] = handler
            liveSession?.registerClientTool(name, handler)
        }
    }

    /** Every transcript segment of the current or last call, in conversation order. */
    public fun getTranscript(): List<TranscriptSegment> = session?.getTranscript().orEmpty()

    /** Ends the call, if any, and releases the conversation. It cannot be used afterwards. */
    override fun close() {
        scope.launch {
            if (closed) return@launch
            closed = true
            try {
                endSession()
            } catch (_: Throwable) {
            } finally {
                scope.cancel()
            }
        }
    }
}
