package com.fishaudio.agent.internal

import com.fishaudio.agent.ClientToolHandler
import com.fishaudio.agent.ConversationEvent
import com.fishaudio.agent.ConversationStatus
import com.fishaudio.agent.EndReason
import com.fishaudio.agent.FishAgentError
import com.fishaudio.agent.FishAgentErrorCode
import com.fishaudio.agent.MessageRole
import com.fishaudio.agent.SessionAuth
import com.fishaudio.agent.SessionOptions
import com.fishaudio.agent.SessionToken
import com.fishaudio.agent.TranscriptSegment
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Behaviour the shared fixtures cannot express: failures while starting,
 * concurrent hangups, and tool replies that cannot be sent. Test names follow
 * packages/client/src/__tests__/agentSession.test.ts where a test there has a
 * counterpart here.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AgentSessionTest {
    private fun toolCall(
        toolName: String,
        callId: String = "call-1",
        expectsResponse: Boolean = true,
        timeoutMs: Long? = null,
    ): JsonObject = buildJsonObject {
        put("type", "client_tool.call")
        put("callId", callId)
        put("toolName", toolName)
        put("params", JsonObject(emptyMap()))
        put("expectsResponse", expectsResponse)
        timeoutMs?.let { put("timeoutMs", it) }
    }

    private suspend fun failure(block: suspend () -> Unit): Throwable? = runCatching { block() }.exceptionOrNull()

    // ---- start ----

    @Test
    fun `connects and reports the session id`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start()
        assertEquals(ConversationStatus.CONNECTED, session.status)
        assertEquals("sess-1", session.sessionId)
        assertEquals(
            listOf(ConversationEvent.StatusChange(ConversationStatus.CONNECTED), ConversationEvent.Connect("sess-1")),
            harness.takeEvents(),
        )
    }

    @Test
    fun `rejects a session token with an unknown transport before connecting`() = runTest {
        val harness = SessionHarness(this)
        val token = SessionToken(transport = "carrier-pigeon", sessionId = "sess-1")
        val error = failure { harness.start(auth = SessionAuth.Token(token)) } as FishAgentError
        assertEquals(FishAgentErrorCode.UNSUPPORTED_TRANSPORT, error.code)
        assertNull("the transport must not be touched", harness.transport.callbacks)
        assertEquals(emptyList<ConversationEvent>(), harness.events)
    }

    @Test
    fun `disconnects a partially connected session and keeps a microphone error`() = runTest {
        val harness = SessionHarness(this)
        harness.transport.connectError = FishAgentError(FishAgentErrorCode.MIC_PERMISSION_DENIED, "denied")
        val error = failure { harness.start() } as FishAgentError
        assertEquals(FishAgentErrorCode.MIC_PERMISSION_DENIED, error.code)
        assertEquals(1, harness.transport.disconnectCalls)
        assertEquals(
            listOf(
                ConversationEvent.StatusChange(ConversationStatus.ENDED),
                ConversationEvent.Disconnect(EndReason.CONNECTION_LOST),
            ),
            harness.events,
        )
    }

    @Test
    fun `wraps any other connect failure as connection_failed`() = runTest {
        val harness = SessionHarness(this)
        val cause = IOException("ice failed")
        harness.transport.connectError = cause
        val error = failure { harness.start() } as FishAgentError
        assertEquals(FishAgentErrorCode.CONNECTION_FAILED, error.code)
        assertSame(cause, error.cause)
    }

    @Test
    fun `a start without the microphone begins muted and tells the transport`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start(SessionOptions(microphone = false))
        assertTrue(session.micMuted)
        assertFalse(harness.transport.connectOptions!!.microphone)
    }

    @Test
    fun `a public agent start creates the session over HTTP`() = runTest {
        val http = FakeHttp()
        val transport = FakeTransport()
        val session = AgentSession.start(
            SessionAuth.AgentId("agent-1"),
            SessionOptions(),
            SessionDependencies({ transport }, resolver(http), backgroundScope) {},
        )
        assertEquals("sess-http", session.sessionId)
        assertEquals("https://api.fish.audio/v1/agent/sessions", http.requests.single().url)
    }

    // ---- ending ----

    @Test
    fun `concurrent end calls share one hangup`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start()
        harness.transport.disconnectGate = CompletableDeferred()
        val first = async { session.end() }
        val second = async { session.end() }
        runCurrent()
        assertEquals(1, harness.transport.disconnectCalls)
        assertEquals(ConversationStatus.CONNECTED, session.status)
        harness.transport.disconnectGate!!.complete(Unit)
        first.await()
        second.await()
        assertEquals(1, harness.transport.disconnectCalls)
        assertEquals(EndReason.USER_HANGUP, session.endReason)
        assertEquals(1, harness.events.count { it is ConversationEvent.Disconnect })
    }

    @Test
    fun `end after the session ended does nothing`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start()
        harness.transport.state(TransportConnectionState.DISCONNECTED, DisconnectReasons.ROOM_DELETED)
        session.end()
        assertEquals(0, harness.transport.disconnectCalls)
        assertEquals(EndReason.AGENT_HANGUP, session.endReason)
    }

    @Test
    fun `a failed teardown can be retried`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start()
        harness.transport.disconnectError = IOException("still closing")
        assertTrue(failure { session.end() } is IOException)
        assertEquals(ConversationStatus.CONNECTED, session.status)
        harness.transport.disconnectError = null
        session.end()
        assertEquals(EndReason.USER_HANGUP, session.endReason)
        assertEquals(2, harness.transport.disconnectCalls)
    }

    @Test
    fun `hangs up even when the hangup message cannot be sent`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start()
        harness.transport.sendFailures = 1
        session.end()
        assertEquals(EndReason.USER_HANGUP, session.endReason)
        assertEquals(1, harness.transport.disconnectCalls)
    }

    // ---- microphone ----

    @Test
    fun `rolls the muted state back when the microphone cannot be toggled`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start()
        harness.transport.micError = IOException("no device")
        val error = failure { session.setMicMuted(true) } as FishAgentError
        assertEquals(FishAgentErrorCode.CONNECTION_FAILED, error.code)
        assertFalse(session.micMuted)

        harness.transport.micError = null
        session.setMicMuted(true)
        assertTrue(session.micMuted)
        assertFalse(harness.transport.micEnabled)
    }

    // ---- sending ----

    @Test
    fun `reports a message that could not be sent as an error event`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start()
        harness.takeEvents()
        harness.transport.sendFailures = 1
        session.interrupt()
        harness.settle()
        val error = (harness.takeEvents().single() as ConversationEvent.Error).error
        assertEquals(FishAgentErrorCode.CONNECTION_FAILED, error.code)
        assertEquals(ConversationStatus.CONNECTED, session.status)
    }

    @Test
    fun `a listener that throws does not break the session`() = runTest {
        val transport = FakeTransport()
        var calls = 0
        val session = AgentSession.start(
            SessionAuth.Token(validToken()),
            SessionOptions(),
            SessionDependencies({ transport }, resolver(), backgroundScope) {
                calls += 1
                throw IllegalStateException("listener bug")
            },
        )
        transport.state(TransportConnectionState.RECONNECTING)
        assertEquals(ConversationStatus.RECONNECTING, session.status)
        assertTrue(calls >= 3)
    }

    // ---- transcript ----

    @Test
    fun `keeps the transcript in conversation order and refines segments in place`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start()
        harness.transport.transcription("SG_1", MessageRole.AGENT, "Hi", isFinal = false)
        harness.transport.transcription("SG_2", MessageRole.USER, "where", isFinal = false)
        session.sendUserMessage("typed")
        harness.transport.transcription("SG_1", MessageRole.AGENT, "Hi there", isFinal = true)
        harness.transport.transcription("SG_2", MessageRole.USER, "where is it", isFinal = true)
        assertEquals(
            listOf(
                TranscriptSegment("SG_1", MessageRole.AGENT, "Hi there", true),
                TranscriptSegment("SG_2", MessageRole.USER, "where is it", true),
                TranscriptSegment("typed_1", MessageRole.USER, "typed", true),
            ),
            session.getTranscript(),
        )
    }

    @Test
    fun `the same segment id from both sides stays two segments`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start()
        harness.transport.transcription("SG_1", MessageRole.AGENT, "agent text", isFinal = true)
        harness.transport.transcription("SG_1", MessageRole.USER, "user text", isFinal = true)
        assertEquals(listOf(MessageRole.AGENT, MessageRole.USER), session.getTranscript().map { it.role })
    }

    // ---- client tools ----

    @Test
    fun `supports late registration via registerClientTool`() = runTest {
        val harness = SessionHarness(this)
        val session = harness.start()
        session.registerClientTool("late") { _, _ -> "ok" }
        harness.transport.agent(toolCall("late"))
        harness.settle()
        assertEquals("ok", harness.toolResults().single().string("result"))
    }

    @Test
    fun `answers at the deadline even when the handler ignores cancellation`() = runTest {
        val harness = SessionHarness(this)
        harness.start(
            SessionOptions(
                clientTools = mapOf(
                    "stubborn" to ClientToolHandler { _, _ ->
                        withContext(NonCancellable) { delay(60_000) }
                        "too late"
                    },
                ),
            ),
        )
        harness.takeEvents()
        harness.transport.agent(toolCall("stubborn", timeoutMs = 2_000))
        advanceTimeBy(1_800)
        harness.settle()
        val reply = harness.toolResults().single()
        assertEquals(true, reply.boolean("isError"))
        assertEquals(
            FishAgentErrorCode.TOOL_TIMEOUT,
            (harness.takeEvents().single() as ConversationEvent.Error).error.code,
        )
        // The handler finishing later must not send a second reply.
        advanceTimeBy(120_000)
        harness.settle()
        assertEquals(1, harness.toolResults().size)
    }

    @Test
    fun `a handler's own cancellation is a tool failure, not the end of the dispatch`() = runTest {
        val harness = SessionHarness(this)
        harness.start(
            SessionOptions(
                clientTools = mapOf(
                    "gives_up" to ClientToolHandler { _, _ -> kotlinx.coroutines.withTimeout(100) { awaitCancellation() } },
                ),
            ),
        )
        harness.takeEvents()
        harness.transport.agent(toolCall("gives_up"))
        advanceTimeBy(200)
        harness.settle()
        assertEquals(true, harness.toolResults().single().boolean("isError"))
        assertEquals(
            FishAgentErrorCode.TOOL_FAILED,
            (harness.takeEvents().single() as ConversationEvent.Error).error.code,
        )
    }

    @Test
    fun `replaces a result that is not JSON with an error result`() = runTest {
        val harness = SessionHarness(this)
        harness.start(SessionOptions(clientTools = mapOf("bad" to ClientToolHandler { _, _ -> Any() })))
        harness.takeEvents()
        harness.transport.agent(toolCall("bad"))
        harness.settle()
        assertEquals(true, harness.toolResults().single().boolean("isError"))
        assertEquals(
            FishAgentErrorCode.TOOL_FAILED,
            (harness.takeEvents().single() as ConversationEvent.Error).error.code,
        )
    }

    @Test
    fun `trades a result that could not be delivered for an error result`() = runTest {
        val harness = SessionHarness(this)
        harness.start(SessionOptions(clientTools = mapOf("tool" to ClientToolHandler { _, _ -> "value" })))
        harness.takeEvents()
        harness.transport.sendFailures = 1
        harness.transport.agent(toolCall("tool"))
        harness.settle()
        val reply = harness.toolResults().single()
        assertEquals(true, reply.boolean("isError"))
        assertTrue(reply.string("result")!!.startsWith("Client tool result could not be delivered"))
        assertEquals(1, harness.takeEvents().size)
    }

    @Test
    fun `does not loop when the error result cannot be delivered either`() = runTest {
        val harness = SessionHarness(this)
        harness.start(SessionOptions(clientTools = mapOf("tool" to ClientToolHandler { _, _ -> "value" })))
        harness.takeEvents()
        harness.transport.sendFailures = 5
        harness.transport.agent(toolCall("tool"))
        harness.settle()
        assertEquals(emptyList<JsonObject>(), harness.toolResults())
        assertEquals(2, harness.takeEvents().size)
        assertEquals(3, harness.transport.sendFailures)
    }

    @Test
    fun `stops a running tool when the session ends and sends nothing for it`() = runTest {
        val harness = SessionHarness(this)
        var cancelled = false
        harness.start(
            SessionOptions(
                clientTools = mapOf(
                    "slow" to ClientToolHandler { _, _ ->
                        try {
                            awaitCancellation()
                        } finally {
                            cancelled = true
                        }
                    },
                ),
            ),
        )
        harness.transport.agent(toolCall("slow"))
        harness.settle()
        harness.transport.state(TransportConnectionState.DISCONNECTED)
        advanceTimeBy(60_000)
        harness.settle()
        assertTrue(cancelled)
        assertEquals(emptyList<JsonObject>(), harness.toolResults())
    }

    @Test
    fun `a tool call without a call id is dropped`() = runTest {
        val harness = SessionHarness(this)
        harness.start(SessionOptions(clientTools = mapOf("tool" to ClientToolHandler { _, _ -> "value" })))
        harness.takeEvents()
        harness.transport.agent(
            buildJsonObject {
                put("type", "client_tool.call")
                put("toolName", "tool")
                put("expectsResponse", true)
            },
        )
        harness.settle()
        assertEquals(emptyList<JsonObject>(), harness.transport.sent)
        assertEquals(emptyList<ConversationEvent>(), harness.takeEvents())
    }
}
