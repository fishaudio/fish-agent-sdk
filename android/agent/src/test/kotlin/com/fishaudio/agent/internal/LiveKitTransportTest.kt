package com.fishaudio.agent.internal

import com.fishaudio.agent.AgentMode
import com.fishaudio.agent.ConversationEvent
import com.fishaudio.agent.ConversationStatus
import com.fishaudio.agent.EndReason
import com.fishaudio.agent.FishAgentError
import com.fishaudio.agent.FishAgentErrorCode
import com.fishaudio.agent.MessageRole
import com.fishaudio.agent.SessionAuth
import com.fishaudio.agent.SessionOptions
import java.io.IOException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A room the test drives by hand, or from a recording. Records every command it is given. */
internal class FakeRoomAdapter : RoomAdapter {
    override var listener: RoomListener? = null
    override var state: RoomState = RoomState.DISCONNECTED
    override var remoteParticipantCount: Int = 0
    var remoteAttributes: MutableList<MutableMap<String, String>> = ArrayList()

    /** Every command, in order: `connect`, `disconnect`, `attributes {…}`, `data <topic> <json>`, `mic true|false`. */
    val commands = ArrayList<String>()
    var connectError: Throwable? = null
    var publishError: Throwable? = null
    var micError: Throwable? = null

    /** The state `connect()` leaves the room in. Android returns while still CONNECTING. */
    var stateAfterConnect: RoomState = RoomState.CONNECTING

    override fun remoteParticipantAttributes(): List<Map<String, String>> = remoteAttributes

    override suspend fun connect(url: String, token: String) {
        commands.add("connect")
        connectError?.let { throw it }
        state = stateAfterConnect
    }

    override fun disconnect() {
        commands.add("disconnect")
        state = RoomState.DISCONNECTED
    }

    override fun setLocalAttributes(attributes: Map<String, String>) {
        commands.add("attributes $attributes @$state")
    }

    override suspend fun publishData(payload: ByteArray, topic: String) {
        publishError?.let { throw it }
        commands.add("data $topic ${String(payload, Charsets.UTF_8)}")
    }

    override suspend fun setMicrophoneEnabled(enabled: Boolean) {
        micError?.let { throw it }
        commands.add("mic $enabled")
    }

    fun audioReadyAttributes(): List<String> =
        commands.filter { it.startsWith("attributes ") }.map { it.substringAfter("audio_ready=").substringBefore("}") }

    fun dataSent(): List<JsonObject> = commands.filter { it.startsWith("data ") }
        .map { Json.parseToJsonElement(it.substringAfter("data client-event ")).jsonObject }
}

/** The whole stack above the room: a session on a real transport on a fake room. */
@OptIn(ExperimentalCoroutinesApi::class)
internal class StackHarness(private val scope: TestScope) {
    val room = FakeRoomAdapter()
    val events = ArrayList<ConversationEvent>()
    val transport = LiveKitTransport(room, scope.backgroundScope) { NOW_MS + scope.currentTime }
    lateinit var session: AgentSession
    private var starting: Deferred<AgentSession>? = null

    /** Begins a start. It finishes once the room reports CONNECTED; see [connected]. */
    fun beginStart(options: SessionOptions = SessionOptions()) {
        // A job of its own: a start that is expected to fail must not fail the test scope.
        starting = scope.async(SupervisorJob()) {
            AgentSession.start(
                SessionAuth.Token(validToken()),
                options,
                SessionDependencies({ transport }, resolver(), scope.backgroundScope) { events.add(it) },
            )
        }
        scope.runCurrent()
    }

    /** The room reports CONNECTED and the start completes. */
    suspend fun connected() {
        room.state = RoomState.CONNECTED
        room.listener!!.onConnected()
        session = starting!!.await()
        scope.runCurrent()
    }

    suspend fun start(options: SessionOptions = SessionOptions()) {
        beginStart(options)
        connected()
    }

    suspend fun startFailure(): Throwable? = runCatching { starting!!.await() }.exceptionOrNull()

    /** The agent joins, announces it is ready and its voice track is subscribed. */
    fun agentJoins() {
        room.remoteParticipantCount = 1
        room.remoteAttributes = arrayListOf(HashMap())
        room.listener!!.onParticipantConnected(emptyMap())
        agentAttributes("lk.agent.state" to "listening")
        agentAttributes("fish.agent.ready" to "1")
        room.listener!!.onAudioTrackSubscribed(isMicrophoneSource = true)
        scope.runCurrent()
    }

    fun agentAttributes(vararg changed: Pair<String, String>) {
        room.remoteAttributes.firstOrNull()?.putAll(changed)
        room.listener!!.onAttributesChanged(isLocal = false, changed = mapOf(*changed))
    }

    fun statuses(): List<ConversationStatus> = events.filterIsInstance<ConversationEvent.StatusChange>().map { it.status }
    fun messages(): List<Pair<MessageRole, String>> =
        events.filterIsInstance<ConversationEvent.Message>().map { it.role to it.text }
}

/**
 * Replays an event sequence recorded from a real call (see
 * src/test/resources/livekit-recordings/README.md) into the room listener, at
 * the recorded times, with the room state and roster the recording shows.
 */
@OptIn(ExperimentalCoroutinesApi::class)
internal class Recording(name: String) {
    val lines: List<JsonObject> = checkNotNull(javaClass.getResourceAsStream("/livekit-recordings/$name.jsonl")) {
        "recording $name not found"
    }.bufferedReader().readLines().filter { it.isNotBlank() }.map { Json.parseToJsonElement(it).jsonObject }

    private fun JsonObject.attributes(key: String): Map<String, String> =
        (this[key] as? JsonObject)?.mapValues { it.value.jsonPrimitive.content } ?: emptyMap()

    /**
     * Plays lines `from` (inclusive) to `until` (exclusive). [onCommand] is
     * called for the probe's own `cmd` lines, so a test can do what the probe did.
     */
    suspend fun replay(
        scope: TestScope,
        stack: StackHarness,
        from: Int = 0,
        until: Int = lines.size,
        onCommand: suspend (String) -> Unit = {},
    ) {
        val room = stack.room
        for (line in lines.subList(from, until)) {
            val event = line.string("e")!!
            val at = line.getValue("t").jsonPrimitive.long
            if (at > scope.currentTime) scope.advanceTimeBy(at - scope.currentTime)
            scope.runCurrent()
            line.string("roomState")?.let { recorded ->
                // The fake room's own disconnect() already moved it; the recording agrees from then on.
                room.state = RoomState.valueOf(recorded)
            }
            line["remotes"]?.let { room.remoteParticipantCount = it.jsonPrimitive.long.toInt() }
            val listener = room.listener
            when (event) {
                "Connected" -> if (!stack.isStarted()) stack.connected() else listener?.onConnected()
                "Reconnecting" -> listener?.onReconnecting()
                "Reconnected" -> listener?.onReconnected()
                "Disconnected" -> listener?.onDisconnected(line.string("reason")!!)
                "ParticipantConnected" -> {
                    room.remoteAttributes = arrayListOf(HashMap(line.attributes("attributes")))
                    listener?.onParticipantConnected(line.attributes("attributes"))
                }
                "ParticipantDisconnected" -> {
                    room.remoteAttributes = ArrayList()
                    listener?.onParticipantDisconnected()
                }
                "ParticipantAttributesChanged" -> {
                    val isLocal = line.getValue("participant").jsonObject.boolean("isLocal") == true
                    val changed = line.attributes("changed")
                    if (!isLocal) room.remoteAttributes.firstOrNull()?.putAll(changed)
                    listener?.onAttributesChanged(isLocal, changed)
                }
                "TrackSubscribed" ->
                    if (line.string("kind") == "AUDIO") listener?.onAudioTrackSubscribed(line.string("source") == "MICROPHONE")
                "DataReceived" -> listener?.onData(line.string("topic"), line.string("payload")!!.toByteArray())
                "stream.open" -> listener?.onTextStreamOpened(
                    line.string("streamId")!!,
                    Protocol.TRANSCRIPTION_TOPIC,
                    line.boolean("fromLocal") == true,
                    line.attributes("attributes"),
                )
                "stream.chunk" -> listener?.onTextStreamChunk(line.string("streamId")!!, line.string("text")!!)
                "stream.close" -> listener?.onTextStreamClosed(line.string("streamId")!!, aborted = false)
                "stream.error" -> listener?.onTextStreamClosed(line.string("streamId")!!, aborted = true)
                "cmd" -> onCommand(line.string("cmd")!!)
                // The probe's own actions and events the transport has no use for.
                "token", "connect.begin", "connect.returned", "attr.pending.sent", "attr.ready.sent", "mic.enabled",
                "sent", "disconnect.returned", "state.connected.seen", "other", "ParticipantStateChanged",
                "TrackPublished", "TrackUnpublished", "TrackUnsubscribed",
                -> Unit
                else -> error("recording line ${line["n"]}: unknown event \"$event\"; update the replay")
            }
            scope.runCurrent()
        }
    }

    fun indexOf(predicate: (JsonObject) -> Boolean): Int = lines.indexOfFirst(predicate).also { check(it >= 0) }
}

private fun StackHarness.isStarted(): Boolean = runCatching { session }.isSuccess

@OptIn(ExperimentalCoroutinesApi::class)
class LiveKitTransportTest {
    private val agentOpening = "Hi, thanks for calling Fernway support. How can I help with your order?"

    // ---- replayed recordings ----

    @Test
    fun `recorded local hangup ends as user_hangup`() = runTest {
        val stack = StackHarness(this)
        val recording = Recording("local-hangup")
        stack.beginStart()
        recording.replay(this, stack) { command ->
            if (command == "hangup") stack.session.end()
        }
        assertEquals(EndReason.USER_HANGUP, stack.session.endReason)
        assertEquals(listOf(ConversationStatus.CONNECTED, ConversationStatus.ENDED), stack.statuses())
        assertEquals(listOf(MessageRole.AGENT to agentOpening), stack.messages())
        assertEquals(1, stack.events.count { it is ConversationEvent.Disconnect })
        assertTrue(stack.room.dataSent().any { it.string("type") == "user.hangup" })
    }

    @Test
    fun `recorded join reports audio readiness once, as attribute and message`() = runTest {
        val stack = StackHarness(this)
        val recording = Recording("local-hangup")
        stack.beginStart()
        recording.replay(this, stack, until = recording.indexOf { it.string("e") == "cmd" })

        val attributes = stack.room.audioReadyAttributes()
        assertEquals("pending", attributes.first())
        assertEquals(2, attributes.size)
        val stamp = attributes.last()
        val reports = stack.room.dataSent().filter { it.string("type") == "client.audio_ready" }
        assertEquals(1, reports.size)
        assertEquals(stamp.toDouble(), reports.single().number("at"))
        assertEquals(ConversationStatus.CONNECTED, stack.session.status)
        // The agent's opening line played and ended.
        assertEquals(AgentMode.LISTENING, stack.session.mode)
        assertTrue(ConversationEvent.ModeChange(AgentMode.SPEAKING) in stack.events)
    }

    @Test
    fun `recorded join sets pending only after the room is connected`() = runTest {
        val stack = StackHarness(this)
        val recording = Recording("pending-set-after-connected")
        stack.beginStart()
        // connect() has returned, the room is still CONNECTING: nothing may be set yet.
        assertEquals(listOf("connect"), stack.room.commands)
        recording.replay(this, stack)
        val first = stack.room.commands.first { it.startsWith("attributes ") }
        assertTrue(first, first.endsWith("@CONNECTED"))
        assertTrue(first, "audio_ready=pending" in first)
    }

    @Test
    fun `recorded end forced by the backend ends with the announced reason`() = runTest {
        val stack = StackHarness(this)
        stack.beginStart()
        Recording("server-end").replay(this, stack)
        // The runtime announces a backend-forced end as user_hangup.
        assertEquals(EndReason.USER_HANGUP, stack.session.endReason)
        assertEquals(listOf(ConversationStatus.CONNECTED, ConversationStatus.ENDED), stack.statuses())
    }

    @Test
    fun `recorded agent hangup ends as agent_hangup`() = runTest {
        val stack = StackHarness(this)
        stack.beginStart()
        Recording("agent-hangup").replay(this, stack)
        assertEquals(EndReason.AGENT_HANGUP, stack.session.endReason)
        assertEquals(
            listOf(agentOpening, "No problem. To get started, what's the name on the order and the billing ZIP code?",
                "I'll hang up for now, but feel free to call us back anytime."),
            stack.messages().map { it.second },
        )
    }

    @Test
    fun `recorded 3 second outage reconnects without ending`() = runTest {
        assertOutageRecovers("network-off-3s")
    }

    @Test
    fun `recorded 12 second outage reconnects without ending`() = runTest {
        assertOutageRecovers("network-off-12s")
    }

    private suspend fun TestScope.assertOutageRecovers(name: String) {
        val stack = StackHarness(this)
        stack.beginStart()
        Recording(name).replay(this, stack)
        // Well past the roster grace: the session must still be alive.
        advanceTimeBy(ROSTER_GRACE_MS * 3)
        runCurrent()
        assertEquals(
            listOf(ConversationStatus.CONNECTED, ConversationStatus.RECONNECTING, ConversationStatus.CONNECTED),
            stack.statuses(),
        )
        assertNull(stack.session.endReason)
        // The readiness value is set again after the reconnect, unchanged.
        val attributes = stack.room.audioReadyAttributes()
        assertEquals(3, attributes.size)
        assertEquals(attributes[1], attributes[2])
        // Our own packet echoed back on client-event is not an agent event.
        assertFalse(stack.events.any { it is ConversationEvent.Error })
    }

    @Test
    fun `recorded 40 second outage survives an empty roster at Reconnected`() = runTest {
        val stack = StackHarness(this)
        val recording = Recording("network-off-40s")
        stack.beginStart()
        val reconnected = recording.indexOf { it.string("e") == "Reconnected" }
        recording.replay(this, stack, until = reconnected + 1)
        // Reconnected arrived with nobody in the roster. That is not a hangup yet.
        assertEquals(0, stack.room.remoteParticipantCount)
        assertEquals(ConversationStatus.CONNECTED, stack.session.status)

        val gone = recording.indexOf { it.string("e") == "Disconnected" }
        recording.replay(this, stack, from = reconnected + 1, until = gone)
        assertEquals(ConversationStatus.CONNECTED, stack.session.status)
        assertNull(stack.session.endReason)

        // The agent then hung up for silence; no announcement reached the client.
        recording.replay(this, stack, from = gone)
        assertEquals(EndReason.AGENT_HANGUP, stack.session.endReason)
        assertEquals(
            listOf(ConversationStatus.CONNECTED, ConversationStatus.RECONNECTING, ConversationStatus.CONNECTED, ConversationStatus.ENDED),
            stack.statuses(),
        )
    }

    // ---- what the recordings do not cover ----

    @Test
    fun `an empty roster that stays empty after a reconnect is the agent hanging up`() = runTest {
        val stack = StackHarness(this)
        stack.start()
        stack.agentJoins()
        stack.room.state = RoomState.RECONNECTING
        stack.room.listener!!.onReconnecting()
        stack.room.remoteParticipantCount = 0
        stack.room.listener!!.onParticipantDisconnected()
        stack.room.state = RoomState.CONNECTED
        stack.room.listener!!.onReconnected()
        advanceTimeBy(ROSTER_GRACE_MS - 1)
        runCurrent()
        assertEquals(ConversationStatus.CONNECTED, stack.session.status)
        advanceTimeBy(1)
        runCurrent()
        assertEquals(EndReason.AGENT_HANGUP, stack.session.endReason)
        assertEquals("disconnect", stack.room.commands.last())
    }

    @Test
    fun `the agent leaving a room that stays connected is agent_hangup`() = runTest {
        val stack = StackHarness(this)
        stack.start()
        stack.agentJoins()
        stack.room.remoteParticipantCount = 0
        stack.room.listener!!.onParticipantDisconnected()
        runCurrent()
        assertEquals(EndReason.AGENT_HANGUP, stack.session.endReason)
        assertEquals("disconnect", stack.room.commands.last())
    }

    @Test
    fun `a reconnect that starts right behind an emptied roster is not a hangup`() = runTest {
        val stack = StackHarness(this)
        stack.start()
        stack.agentJoins()
        // The order the browser SDK shows: roster cleared while the state still reads connected.
        stack.room.remoteParticipantCount = 0
        stack.room.listener!!.onParticipantDisconnected()
        stack.room.state = RoomState.RECONNECTING
        stack.room.listener!!.onReconnecting()
        runCurrent()
        assertEquals(ConversationStatus.RECONNECTING, stack.session.status)
        assertNull(stack.session.endReason)
    }

    @Test
    fun `one of two remote participants leaving is not the agent leaving`() = runTest {
        val stack = StackHarness(this)
        stack.start()
        stack.agentJoins()
        stack.room.remoteParticipantCount = 1
        stack.room.listener!!.onParticipantDisconnected()
        runCurrent()
        assertEquals(ConversationStatus.CONNECTED, stack.session.status)
    }

    @Test
    fun `an agent already in the room is read from its sticky attributes`() = runTest {
        val stack = StackHarness(this)
        stack.room.remoteParticipantCount = 1
        stack.room.remoteAttributes = arrayListOf(hashMapOf("lk.agent.state" to "listening", "fish.agent.ready" to "1"))
        stack.start()
        stack.session.sendUserMessage("hello")
        runCurrent()
        // Sent at once: the ready signal was read on connect, no change event needed.
        assertEquals(listOf("user.message"), stack.room.dataSent().map { it.string("type") })
    }

    @Test
    fun `a ready stamp reported while connecting is not overwritten by pending`() = runTest {
        val stack = StackHarness(this)
        stack.beginStart()
        stack.room.listener!!.onAudioTrackSubscribed(isMicrophoneSource = true)
        stack.connected()
        val attributes = stack.room.audioReadyAttributes()
        assertEquals(2, attributes.size)
        assertEquals(attributes[0], attributes[1])
        assertFalse("pending" in attributes)
    }

    @Test
    fun `only the microphone-source track counts as the agent's voice`() = runTest {
        val stack = StackHarness(this)
        stack.start()
        stack.room.listener!!.onAudioTrackSubscribed(isMicrophoneSource = false)
        runCurrent()
        assertEquals(listOf("pending"), stack.room.audioReadyAttributes())
        stack.room.listener!!.onAudioTrackSubscribed(isMicrophoneSource = true)
        stack.room.listener!!.onAudioTrackSubscribed(isMicrophoneSource = true)
        runCurrent()
        assertEquals(2, stack.room.audioReadyAttributes().size)
        assertEquals(1, stack.room.dataSent().count { it.string("type") == "client.audio_ready" })
    }

    @Test
    fun `a failed readiness report does not break the call`() = runTest {
        val stack = StackHarness(this)
        stack.start()
        stack.room.publishError = IOException("data channel closed")
        stack.room.listener!!.onAudioTrackSubscribed(isMicrophoneSource = true)
        runCurrent()
        assertEquals(ConversationStatus.CONNECTED, stack.session.status)
        assertFalse(stack.events.any { it is ConversationEvent.Error })
    }

    @Test
    fun `the microphone is published during connect unless the call starts without it`() = runTest {
        val withMic = StackHarness(this)
        withMic.start()
        assertTrue("mic true" in withMic.room.commands)

        val withoutMic = StackHarness(this)
        withoutMic.start(SessionOptions(microphone = false))
        assertFalse(withoutMic.room.commands.any { it.startsWith("mic ") })
        withoutMic.session.setMicMuted(false)
        assertEquals("mic true", withoutMic.room.commands.last())
        assertFalse(withoutMic.session.micMuted)
    }

    @Test
    fun `a microphone failure during connect fails the start and leaves the room`() = runTest {
        val stack = StackHarness(this)
        stack.room.micError = FishAgentError(FishAgentErrorCode.MIC_PERMISSION_DENIED, "denied")
        stack.beginStart()
        stack.room.state = RoomState.CONNECTED
        stack.room.listener!!.onConnected()
        val error = stack.startFailure() as FishAgentError
        assertEquals(FishAgentErrorCode.MIC_PERMISSION_DENIED, error.code)
        assertEquals("disconnect", stack.room.commands.last())
    }

    @Test
    fun `a room that fails to connect fails the start as connection_failed`() = runTest {
        val stack = StackHarness(this)
        stack.room.connectError = IOException("could not reach the server")
        stack.beginStart()
        assertEquals(FishAgentErrorCode.CONNECTION_FAILED, (stack.startFailure() as FishAgentError).code)
    }

    @Test
    fun `a room that disconnects before it is connected fails the start`() = runTest {
        val stack = StackHarness(this)
        stack.beginStart()
        stack.room.state = RoomState.DISCONNECTED
        stack.room.listener!!.onDisconnected("JOIN_FAILURE")
        assertEquals(FishAgentErrorCode.CONNECTION_FAILED, (stack.startFailure() as FishAgentError).code)
    }

    @Test
    fun `a room that never reports connected fails the start after the timeout`() = runTest {
        val stack = StackHarness(this)
        stack.beginStart()
        advanceTimeBy(ROOM_CONNECTED_TIMEOUT_MS + 1)
        assertEquals(FishAgentErrorCode.CONNECTION_FAILED, (stack.startFailure() as FishAgentError).code)
        assertEquals("disconnect", stack.room.commands.last())
    }

    @Test
    fun `a room that is already connected when connect returns does not wait`() = runTest {
        val stack = StackHarness(this)
        stack.room.stateAfterConnect = RoomState.CONNECTED
        stack.beginStart()
        assertTrue(stack.startFailure() == null)
        assertEquals("pending", stack.room.audioReadyAttributes().single())
    }

    @Test
    fun `data on other topics, or that is not a typed JSON object, is dropped`() = runTest {
        val stack = StackHarness(this)
        stack.start()
        stack.events.clear()
        val listener = stack.room.listener!!
        listener.onData("client-event", """{"type":"error","code":"internal_error"}""".toByteArray())
        listener.onData(null, """{"type":"error","code":"internal_error"}""".toByteArray())
        listener.onData("agent-event", "not json".toByteArray())
        listener.onData("agent-event", "[1,2]".toByteArray())
        listener.onData("agent-event", """{"code":"internal_error"}""".toByteArray())
        listener.onData("agent-event", """{"type":7}""".toByteArray())
        assertEquals(emptyList<ConversationEvent>(), stack.events)
        listener.onData("agent-event", """{"type":"error","code":"internal_error"}""".toByteArray())
        assertEquals(1, stack.events.size)
    }

    @Test
    fun `transcript streams follow the stream rules`() = runTest {
        val stack = StackHarness(this)
        stack.start()
        stack.events.clear()
        val listener = stack.room.listener!!
        val topic = Protocol.TRANSCRIPTION_TOPIC

        // No segment id: ignored.
        listener.onTextStreamOpened("s0", topic, false, emptyMap())
        listener.onTextStreamChunk("s0", "ignored")
        listener.onTextStreamClosed("s0", aborted = false)
        // Another topic: ignored.
        listener.onTextStreamOpened("s1", "chat", false, mapOf("lk.segment_id" to "SG_x"))
        listener.onTextStreamChunk("s1", "ignored")
        listener.onTextStreamClosed("s1", aborted = false)
        // An empty stream produces nothing.
        listener.onTextStreamOpened("s2", topic, false, mapOf("lk.segment_id" to "SG_empty"))
        listener.onTextStreamClosed("s2", aborted = false)
        assertEquals(emptyList<ConversationEvent>(), stack.events)

        // The user's speech: each update is a stream of its own carrying the whole text.
        listener.onTextStreamOpened("u1", topic, true, mapOf("lk.segment_id" to "SG_u", "lk.transcription_final" to "false"))
        listener.onTextStreamChunk("u1", "where is")
        listener.onTextStreamClosed("u1", aborted = false)
        listener.onTextStreamOpened("u2", topic, true, mapOf("lk.segment_id" to "SG_u", "lk.transcription_final" to "true"))
        listener.onTextStreamChunk("u2", "where is my order")
        listener.onTextStreamClosed("u2", aborted = false)
        assertEquals(listOf(MessageRole.USER to "where is my order"), stack.messages())
        assertEquals(
            listOf(false, false, false, true),
            stack.events.filterIsInstance<ConversationEvent.UserTranscript>().map { it.isFinal },
        )

        // A user stream marked final but aborted is not final.
        stack.events.clear()
        listener.onTextStreamOpened("u3", topic, true, mapOf("lk.segment_id" to "SG_u3", "lk.transcription_final" to "true"))
        listener.onTextStreamChunk("u3", "half a sen")
        listener.onTextStreamClosed("u3", aborted = true)
        assertEquals(emptyList<Pair<MessageRole, String>>(), stack.messages())

        // An interrupted agent reply is final with what was spoken.
        listener.onTextStreamOpened("a1", topic, false, mapOf("lk.segment_id" to "SG_a"))
        listener.onTextStreamChunk("a1", "Your order")
        listener.onTextStreamChunk("a1", " is on")
        listener.onTextStreamClosed("a1", aborted = true)
        assertEquals(listOf(MessageRole.AGENT to "Your order is on"), stack.messages())
        assertEquals(AgentMode.LISTENING, stack.session.mode)
    }

    @Test
    fun `sending after the session left the room fails`() = runTest {
        val stack = StackHarness(this)
        stack.start()
        stack.transport.disconnect()
        val error = runCatching { stack.transport.sendClientEvent(ClientMessages.userActivity()) }.exceptionOrNull()
        assertEquals(FishAgentErrorCode.CONNECTION_FAILED, (error as FishAgentError).code)
    }

    @Test
    fun `nothing is reported after a disconnect was reported`() = runTest {
        val stack = StackHarness(this)
        stack.start()
        stack.agentJoins()
        stack.room.remoteParticipantCount = 0
        stack.room.listener!!.onParticipantDisconnected()
        runCurrent()
        assertEquals(EndReason.AGENT_HANGUP, stack.session.endReason)
        val count = stack.events.size
        // LiveKit then reports the disconnect we asked for.
        stack.room.listener?.onDisconnected("CLIENT_INITIATED")
        assertEquals(count, stack.events.size)
        assertEquals(EndReason.AGENT_HANGUP, stack.session.endReason)
    }
}
