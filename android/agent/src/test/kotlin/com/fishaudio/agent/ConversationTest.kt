package com.fishaudio.agent

import com.fishaudio.agent.internal.AudioRouter
import com.fishaudio.agent.internal.CallSlot
import com.fishaudio.agent.internal.CallTransport
import com.fishaudio.agent.internal.ConversationEnvironment
import com.fishaudio.agent.internal.DisconnectReasons
import com.fishaudio.agent.internal.FakeHttp
import com.fishaudio.agent.internal.FakeTransport
import com.fishaudio.agent.internal.TransportConnectionState
import com.fishaudio.agent.internal.resolver
import com.fishaudio.agent.internal.string
import com.fishaudio.agent.internal.validToken
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.plus
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The device, faked: permission, call service, and one [FakeTransport] per call. */
@OptIn(ExperimentalCoroutinesApi::class)
internal class FakeEnvironment(testScope: TestScope, http: FakeHttp = FakeHttp()) : ConversationEnvironment {
    override val scope: CoroutineScope =
        testScope.backgroundScope + SupervisorJob(testScope.backgroundScope.coroutineContext.job)
    override val tokens = resolver(http)

    var microphoneGranted = true
    var serviceStarts = 0
    var serviceStops = 0
    val serviceRunning: Boolean get() = serviceStarts > serviceStops
    var serviceRefused = false
    val notifications = ArrayList<CallNotification>()

    /** One per call, in order. Set [nextTransport] to prepare the next call's transport before it starts. */
    val transports = ArrayList<FakeTransport>()
    var nextTransport = FakeTransport()
    val routes = ArrayList<AudioOutputRoute>()

    val transport: FakeTransport get() = transports.last()

    override fun hasMicrophonePermission(): Boolean = microphoneGranted

    override fun createTransport(route: AudioOutputRoute): CallTransport {
        val created = nextTransport
        nextTransport = FakeTransport()
        transports.add(created)
        routes.add(route)
        return CallTransport(created, AudioRouter { routes.add(it) })
    }

    override fun startCallService(notification: CallNotification): Boolean {
        if (serviceRefused) return false
        serviceStarts += 1
        notifications.add(notification)
        return true
    }

    override fun stopCallService() {
        serviceStops += 1
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class ConversationTest {
    private val auth = SessionAuth.Token(validToken())

    @After
    fun releaseTheCallSlot() = CallSlot.clearForTests()

    private fun TestScope.conversation(
        environment: FakeEnvironment = FakeEnvironment(this),
        defaults: SessionOptions = SessionOptions(),
        mobile: MobileOptions = MobileOptions(),
    ): Pair<Conversation, FakeEnvironment> = Conversation(defaults, mobile, environment) to environment

    /** The agent joins and announces it is ready. */
    private fun TestScope.agentReady(transport: FakeTransport) {
        transport.agentState("initializing")
        transport.ready()
        runCurrent()
    }

    private suspend fun failure(block: suspend () -> Unit): Throwable? = runCatching { block() }.exceptionOrNull()

    // ---- starting ----

    @Test
    fun `starts a call and mirrors its state`() = runTest {
        val (conversation, environment) = conversation()
        assertEquals(ConversationStatus.IDLE, conversation.status.value)
        assertNull(conversation.sessionId)

        val id = conversation.startSession(auth)

        assertEquals("sess-1", id)
        assertEquals("sess-1", conversation.sessionId)
        assertEquals(ConversationStatus.CONNECTED, conversation.status.value)
        assertEquals(AgentMode.LISTENING, conversation.mode.value)
        assertFalse(conversation.micMuted.value)
        assertFalse(conversation.isSpeaking)
        assertEquals(1, environment.transports.size)
        assertTrue(environment.serviceRunning)
        assertEquals(listOf(CallNotification()), environment.notifications)
    }

    @Test
    fun `a second start while one is on its way joins it`() = runTest {
        val (conversation, environment) = conversation()
        environment.nextTransport.connectGate = CompletableDeferred()
        val first = async { conversation.startSession(auth) }
        val second = async { conversation.startSession(auth) }
        runCurrent()
        assertEquals(ConversationStatus.CONNECTING, conversation.status.value)
        environment.transport.connectGate!!.complete(Unit)
        assertEquals("sess-1", first.await())
        assertEquals("sess-1", second.await())
        assertEquals(1, environment.transports.size)
        assertEquals(1, environment.serviceStarts)
    }

    @Test
    fun `a start during a live call returns that call`() = runTest {
        val (conversation, environment) = conversation()
        conversation.startSession(auth)
        assertEquals("sess-1", conversation.startSession(auth))
        assertEquals(1, environment.transports.size)
    }

    @Test
    fun `a failed start goes back to idle and releases everything`() = runTest {
        val (conversation, environment) = conversation()
        environment.nextTransport.connectError = IOException("ice failed")
        val error = failure { conversation.startSession(auth) } as FishAgentError
        assertEquals(FishAgentErrorCode.CONNECTION_FAILED, error.code)
        assertEquals(ConversationStatus.IDLE, conversation.status.value)
        assertNull(conversation.endReason.value)
        assertFalse(environment.serviceRunning)

        // Nothing is left held: the next start works, here or in another conversation.
        val (other, _) = conversation()
        assertEquals("sess-1", other.startSession(auth))
    }

    @Test
    fun `a failed session request creates no transport`() = runTest {
        val environment = FakeEnvironment(this, FakeHttp(status = 402, body = """{"message":"Out of credit"}"""))
        val (conversation, _) = conversation(environment)
        val error = failure { conversation.startSession(SessionAuth.AgentId("agent-1")) } as FishAgentError
        assertEquals(FishAgentErrorCode.INSUFFICIENT_CREDIT, error.code)
        assertEquals(0, environment.transports.size)
        assertEquals(ConversationStatus.IDLE, conversation.status.value)
        assertFalse(environment.serviceRunning)
    }

    @Test
    fun `without the microphone permission the start fails before anything is created`() = runTest {
        val http = FakeHttp()
        val environment = FakeEnvironment(this, http)
        environment.microphoneGranted = false
        val (conversation, _) = conversation(environment)
        val error = failure { conversation.startSession(SessionAuth.AgentId("agent-1")) } as FishAgentError
        assertEquals(FishAgentErrorCode.MIC_PERMISSION_DENIED, error.code)
        assertEquals("no server session may be created", 0, http.requests.size)
        assertEquals(0, environment.transports.size)
        assertEquals(0, environment.serviceStarts)
        assertEquals(ConversationStatus.IDLE, conversation.status.value)
    }

    @Test
    fun `per-call options adjust the defaults`() = runTest {
        val (conversation, environment) = conversation(defaults = SessionOptions(microphone = true))
        conversation.startSession(auth) { it.copy(microphone = false) }
        assertFalse(environment.transport.connectOptions!!.microphone)
        assertTrue(conversation.micMuted.value)
    }

    // ---- the call service and the microphone ----

    @Test
    fun `a call without the microphone runs no service until the first unmute`() = runTest {
        val environment = FakeEnvironment(this)
        environment.microphoneGranted = false
        val (conversation, _) = conversation(environment, defaults = SessionOptions(microphone = false))
        // No permission needed for a call that does not capture.
        conversation.startSession(auth)
        assertEquals(0, environment.serviceStarts)
        assertTrue(conversation.micMuted.value)

        val denied = failure { conversation.setMicMuted(false) } as FishAgentError
        assertEquals(FishAgentErrorCode.MIC_PERMISSION_DENIED, denied.code)
        assertTrue(conversation.micMuted.value)
        assertEquals(0, environment.serviceStarts)

        environment.microphoneGranted = true
        conversation.setMicMuted(false)
        assertFalse(conversation.micMuted.value)
        assertTrue(environment.transport.micEnabled)
        assertEquals(1, environment.serviceStarts)

        // Muting and unmuting again does not start it twice.
        conversation.setMicMuted(true)
        conversation.setMicMuted(false)
        assertEquals(1, environment.serviceStarts)
    }

    @Test
    fun `no service runs when the call notification is turned off`() = runTest {
        val (conversation, environment) = conversation(mobile = MobileOptions(callNotification = null))
        conversation.startSession(auth)
        assertEquals(0, environment.serviceStarts)
        conversation.endSession()
        assertEquals(0, environment.serviceStops)
    }

    @Test
    fun `a refused call service does not stop the call`() = runTest {
        val environment = FakeEnvironment(this)
        environment.serviceRefused = true
        val (conversation, _) = conversation(environment)
        conversation.startSession(auth)
        assertEquals(ConversationStatus.CONNECTED, conversation.status.value)
        conversation.endSession()
        assertEquals("a service that never started is not stopped", 0, environment.serviceStops)
    }

    @Test
    fun `the custom notification reaches the service`() = runTest {
        val notification = CallNotification(title = "Talking to support", text = "Tap to return")
        val (conversation, environment) = conversation(mobile = MobileOptions(callNotification = notification))
        conversation.startSession(auth)
        assertEquals(listOf(notification), environment.notifications)
    }

    @Test
    fun `mute does nothing without a call`() = runTest {
        val (conversation, _) = conversation()
        conversation.setMicMuted(true)
        assertFalse(conversation.micMuted.value)
    }

    // ---- ending ----

    @Test
    fun `hanging up ends the call and releases the service`() = runTest {
        val (conversation, environment) = conversation()
        conversation.startSession(auth)
        conversation.endSession()
        assertEquals(ConversationStatus.ENDED, conversation.status.value)
        assertEquals(EndReason.USER_HANGUP, conversation.endReason.value)
        assertFalse(environment.serviceRunning)
        assertEquals(1, environment.transport.disconnectCalls)
        // Again does nothing.
        conversation.endSession()
        assertEquals(1, environment.transport.disconnectCalls)
        assertEquals(1, environment.serviceStops)
    }

    @Test
    fun `a call ended by the other side releases the service too`() = runTest {
        val (conversation, environment) = conversation()
        conversation.startSession(auth)
        environment.transport.state(TransportConnectionState.DISCONNECTED, DisconnectReasons.ROOM_DELETED)
        assertEquals(ConversationStatus.ENDED, conversation.status.value)
        assertEquals(EndReason.AGENT_HANGUP, conversation.endReason.value)
        assertFalse(environment.serviceRunning)
        assertEquals("sess-1", conversation.sessionId)
    }

    @Test
    fun `hanging up during a start cancels it and closes the late session`() = runTest {
        val (conversation, environment) = conversation()
        environment.nextTransport.connectGate = CompletableDeferred()
        val start = async(SupervisorJob()) { conversation.startSession(auth) }
        runCurrent()
        val hangup = async { conversation.endSession() }
        runCurrent()
        assertEquals(ConversationStatus.ENDED, conversation.status.value)

        environment.transport.connectGate!!.complete(Unit)
        hangup.await()
        assertTrue(failure { start.await() } is ConversationStartCancelledException)
        assertEquals("the late session must be closed", 1, environment.transport.disconnectCalls)
        assertEquals(ConversationStatus.ENDED, conversation.status.value)
        assertNull(conversation.sessionId)
        assertFalse(environment.serviceRunning)
    }

    @Test
    fun `a start right after hanging up on a start waits for it and then connects`() = runTest {
        val (conversation, environment) = conversation()
        environment.nextTransport.connectGate = CompletableDeferred()
        val first = async(SupervisorJob()) { conversation.startSession(auth) }
        runCurrent()
        val firstTransport = environment.transport
        launch { conversation.endSession() }
        runCurrent()
        // Not awaited: the user taps call again at once.
        val second = async { conversation.startSession(auth) }
        runCurrent()
        assertEquals("the new call waits for the old start to finish", 1, environment.transports.size)
        assertEquals(ConversationStatus.CONNECTING, conversation.status.value)

        firstTransport.connectGate!!.complete(Unit)
        assertEquals("sess-1", second.await())
        assertTrue(failure { first.await() } is ConversationStartCancelledException)
        assertEquals(2, environment.transports.size)
        assertEquals(ConversationStatus.CONNECTED, conversation.status.value)
        assertTrue("the new call holds the service", environment.serviceRunning)
        assertEquals(1, firstTransport.disconnectCalls)
    }

    @Test
    fun `a cancelled caller stops waiting but the call still starts`() = runTest {
        val (conversation, environment) = conversation()
        environment.nextTransport.connectGate = CompletableDeferred()
        val caller = launch { conversation.startSession(auth) }
        runCurrent()
        caller.cancelAndJoin()
        assertEquals(ConversationStatus.CONNECTING, conversation.status.value)
        environment.transport.connectGate!!.complete(Unit)
        runCurrent()
        assertEquals(ConversationStatus.CONNECTED, conversation.status.value)
        assertEquals("sess-1", conversation.sessionId)
    }

    @Test
    fun `close ends the call and the conversation cannot start again`() = runTest {
        val (conversation, environment) = conversation()
        conversation.startSession(auth)
        conversation.close()
        runCurrent()
        assertEquals(ConversationStatus.ENDED, conversation.status.value)
        assertFalse(environment.serviceRunning)
        assertTrue(failure { conversation.startSession(auth) } is IllegalStateException)
    }

    // ---- one call per process ----

    @Test
    fun `a second conversation cannot start while the first has a call`() = runTest {
        val (first, _) = conversation()
        val (second, secondEnvironment) = conversation()
        first.startSession(auth)

        val error = failure { second.startSession(auth) }
        assertTrue("$error", error is IllegalStateException && error !is CancellationException)
        assertEquals(0, secondEnvironment.transports.size)
        assertEquals(ConversationStatus.IDLE, second.status.value)

        first.endSession()
        assertEquals("sess-1", second.startSession(auth))
    }

    @Test
    fun `the slot is free again after the other side ends the call`() = runTest {
        val (first, firstEnvironment) = conversation()
        val (second, _) = conversation()
        first.startSession(auth)
        firstEnvironment.transport.state(TransportConnectionState.DISCONNECTED)
        assertEquals("sess-1", second.startSession(auth))
    }

    // ---- sending ----

    @Test
    fun `senders do nothing without a call`() = runTest {
        val (conversation, environment) = conversation()
        conversation.sendUserMessage("hello")
        conversation.sendUserActivity()
        conversation.interrupt()
        runCurrent()
        assertEquals(0, environment.transports.size)
        assertEquals(emptyList<ChatMessage>(), conversation.messages.value)

        conversation.startSession(auth)
        conversation.endSession()
        conversation.sendUserMessage("after the call")
        runCurrent()
        assertEquals(listOf("user.hangup"), environment.transport.sent.map { it.string("type") })
    }

    @Test
    fun `a typed message is sent and shown`() = runTest {
        val (conversation, environment) = conversation()
        conversation.startSession(auth)
        agentReady(environment.transport)
        conversation.sendUserMessage("where is my order?")
        runCurrent()
        assertEquals("where is my order?", environment.transport.sent.single().string("text"))
        assertEquals(
            listOf(ChatMessage("user-typed_1", MessageRole.USER, "where is my order?", true)),
            conversation.messages.value,
        )
    }

    // ---- messages and events ----

    @Test
    fun `messages stream in place, stay after the call and are emptied by the next one`() = runTest {
        val (conversation, environment) = conversation()
        conversation.startSession(auth)
        val transport = environment.transport
        transport.transcription("SG_1", MessageRole.AGENT, "Hi", isFinal = false)
        assertEquals(listOf(ChatMessage("agent-SG_1", MessageRole.AGENT, "Hi", false)), conversation.messages.value)
        transport.transcription("SG_2", MessageRole.USER, "where", isFinal = false)
        transport.transcription("SG_1", MessageRole.AGENT, "Hi there", isFinal = true)
        transport.transcription("SG_2", MessageRole.USER, "where is it", isFinal = true)
        val expected = listOf(
            ChatMessage("agent-SG_1", MessageRole.AGENT, "Hi there", true),
            ChatMessage("user-SG_2", MessageRole.USER, "where is it", true),
        )
        assertEquals(expected, conversation.messages.value)

        conversation.endSession()
        assertEquals(expected, conversation.messages.value)
        assertEquals(2, conversation.getTranscript().size)

        conversation.startSession(auth)
        assertEquals(emptyList<ChatMessage>(), conversation.messages.value)
        assertNull(conversation.endReason.value)
        assertEquals(ConversationStatus.CONNECTED, conversation.status.value)
    }

    @Test
    fun `events reach a collector and are not replayed to a late one`() = runTest {
        val (conversation, environment) = conversation()
        val early = ArrayList<ConversationEvent>()
        backgroundScope.launch { conversation.events.collect { early.add(it) } }
        runCurrent()
        conversation.startSession(auth)
        runCurrent()
        assertEquals(
            listOf(ConversationEvent.StatusChange(ConversationStatus.CONNECTED), ConversationEvent.Connect("sess-1")),
            early,
        )

        val late = ArrayList<ConversationEvent>()
        backgroundScope.launch { conversation.events.collect { late.add(it) } }
        runCurrent()
        environment.transport.agentState("thinking")
        runCurrent()
        assertEquals(listOf<ConversationEvent>(ConversationEvent.ModeChange(AgentMode.THINKING)), late)
        assertEquals(AgentMode.THINKING, conversation.mode.value)
    }

    @Test
    fun `a failed start reports its events but leaves no end reason`() = runTest {
        val (conversation, environment) = conversation()
        val seen = ArrayList<ConversationEvent>()
        backgroundScope.launch { conversation.events.collect { seen.add(it) } }
        runCurrent()
        environment.nextTransport.connectError = IOException("ice failed")
        failure { conversation.startSession(auth) }
        runCurrent()
        assertTrue(ConversationEvent.Disconnect(EndReason.CONNECTION_LOST) in seen)
        assertEquals(ConversationStatus.IDLE, conversation.status.value)
        assertNull(conversation.endReason.value)
    }

    // ---- audio route and tools ----

    @Test
    fun `the audio route applies to the call and is kept for the next one`() = runTest {
        val (conversation, environment) = conversation(mobile = MobileOptions(audioOutput = AudioOutputRoute.SPEAKER))
        assertEquals(AudioOutputRoute.SPEAKER, conversation.audioOutput.value)
        conversation.setAudioOutput(AudioOutputRoute.EARPIECE)
        runCurrent()
        assertEquals(AudioOutputRoute.EARPIECE, conversation.audioOutput.value)
        assertEquals("nothing to route before a call", emptyList<AudioOutputRoute>(), environment.routes)

        conversation.startSession(auth)
        assertEquals(listOf(AudioOutputRoute.EARPIECE), environment.routes)
        conversation.setAudioOutput(AudioOutputRoute.AUTO)
        runCurrent()
        assertEquals(listOf(AudioOutputRoute.EARPIECE, AudioOutputRoute.AUTO), environment.routes)

        conversation.endSession()
        conversation.setAudioOutput(AudioOutputRoute.SPEAKER)
        runCurrent()
        assertEquals("the ended call's audio is not touched", 2, environment.routes.size)
        conversation.startSession(auth)
        assertEquals(AudioOutputRoute.SPEAKER, environment.routes.last())
    }

    @Test
    fun `a tool registered on the conversation serves this call and later ones`() = runTest {
        val (conversation, environment) = conversation(
            defaults = SessionOptions(clientTools = mapOf("from_defaults" to ClientToolHandler { _, _ -> "defaults" })),
        )
        fun call(tool: String): JsonObject = buildJsonObject {
            put("type", "client_tool.call")
            put("callId", "call-$tool")
            put("toolName", tool)
            put("params", JsonObject(emptyMap()))
            put("expectsResponse", true)
        }
        fun results(transport: FakeTransport) =
            transport.sent.filter { it.string("type") == "client_tool.result" }.map { it.string("result") }

        conversation.startSession(auth)
        conversation.registerClientTool("registered") { _, _ -> "registered" }
        runCurrent()
        environment.transport.agent(call("registered"))
        environment.transport.agent(call("from_defaults"))
        runCurrent()
        assertEquals(listOf("registered", "defaults"), results(environment.transport))

        conversation.endSession()
        conversation.startSession(auth) { it.copy(clientTools = mapOf("registered" to ClientToolHandler { _, _ -> "per call" })) }
        environment.transport.agent(call("registered"))
        environment.transport.agent(call("from_defaults"))
        runCurrent()
        assertEquals("per-call tools win", listOf("per call", "defaults"), results(environment.transport))
    }
}
