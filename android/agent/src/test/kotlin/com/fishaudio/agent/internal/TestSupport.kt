package com.fishaudio.agent.internal

import com.fishaudio.agent.ConversationEvent
import com.fishaudio.agent.SessionAuth
import com.fishaudio.agent.SessionOptions
import com.fishaudio.agent.SessionToken
import java.io.IOException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

internal const val NOW_MS = 1_795_000_000_000L

internal fun validToken(): SessionToken = SessionToken(
    transport = "livekit",
    sessionId = "sess-1",
    expiresAt = "2099-01-01T00:00:00Z",
    maxDurationSeconds = 600,
    livekitUrl = "wss://example.livekit.cloud",
    token = "tok",
)

/** A transport the test drives by hand. */
internal class FakeTransport : Transport {
    var callbacks: TransportCallbacks? = null
    var connectOptions: TransportConnectOptions? = null
    val sent = ArrayList<JsonObject>()
    var micEnabled = true
    var connectError: Throwable? = null
    var micError: Throwable? = null
    var disconnectError: Throwable? = null
    var disconnectCalls = 0

    /** When set, `disconnect()` waits for it. */
    var disconnectGate: CompletableDeferred<Unit>? = null

    /** Fails the next [sendFailures] sends with [sendError], then delivers normally. */
    var sendError: Throwable? = null
    var sendFailures = 0

    override suspend fun connect(sessionToken: SessionToken, options: TransportConnectOptions) {
        callbacks = options.callbacks
        connectOptions = options
        connectError?.let { throw it }
    }

    override suspend fun disconnect() {
        disconnectCalls += 1
        disconnectGate?.await()
        disconnectError?.let { throw it }
    }

    override suspend fun setMicEnabled(enabled: Boolean) {
        micError?.let { throw it }
        micEnabled = enabled
    }

    override suspend fun sendClientEvent(message: JsonObject) {
        if (sendFailures > 0) {
            sendFailures -= 1
            throw sendError ?: IOException("send failed")
        }
        sent.add(message)
    }

    fun agent(message: JsonObject) = callbacks!!.onAgentEvent(message)
    fun agentState(state: String) = callbacks!!.onAgentState(state)
    fun ready() = callbacks!!.onAgentReady()
    fun state(state: TransportConnectionState, reason: String? = null) = callbacks!!.onConnectionState(state, reason)
    fun transcription(segmentId: String, role: com.fishaudio.agent.MessageRole, text: String, isFinal: Boolean) =
        callbacks!!.onTranscription(TranscriptionSegmentUpdate(segmentId, role, text, isFinal))
}

internal class CapturedRequest(val url: String, val headers: Map<String, String>, val body: String)

/** Answers the session request with a fixed response, or fails like a dead network. */
internal class FakeHttp(
    private val status: Int = 201,
    private val body: String = """{"transport":"livekit","session_id":"sess-http","livekit_url":"wss://x","token":"t"}""",
    private val networkError: Boolean = false,
) : HttpClient {
    val requests = ArrayList<CapturedRequest>()

    override suspend fun post(url: String, headers: Map<String, String>, body: String): HttpResponse {
        requests.add(CapturedRequest(url, headers, body))
        if (networkError) throw IOException("no route to host")
        return HttpResponse(status, this.body)
    }
}

internal const val TEST_SDK_HEADER = "agent-android/test"
internal const val TEST_TIMEZONE = "Asia/Tokyo"

internal fun resolver(http: HttpClient = FakeHttp()): SessionTokenResolver =
    SessionTokenResolver(http, now = { NOW_MS }, clientTimezone = { TEST_TIMEZONE }, sdkHeader = TEST_SDK_HEADER)

/** A session wired to a [FakeTransport], with its events collected. */
@OptIn(ExperimentalCoroutinesApi::class)
internal class SessionHarness(private val scope: TestScope) {
    val transport = FakeTransport()
    val events = ArrayList<ConversationEvent>()
    lateinit var session: AgentSession

    private val dependencies = SessionDependencies(
        createTransport = { transport },
        tokens = resolver(),
        // Cancelled when the test ends, so timers left running do not hang it.
        scope = scope.backgroundScope,
        onEvent = { events.add(it) },
    )

    /** Starts a session. With [agentReady], the agent joins and announces it is ready, as a current runtime does. */
    suspend fun start(
        options: SessionOptions = SessionOptions(),
        auth: SessionAuth = SessionAuth.Token(validToken()),
        agentReady: Boolean = true,
    ): AgentSession {
        session = AgentSession.start(auth, options, dependencies)
        if (agentReady) {
            transport.agentState("initializing")
            transport.ready()
        }
        settle()
        return session
    }

    /** Runs everything that is ready to run now, without moving the clock. */
    fun settle() = scope.runCurrent()

    /** Events seen since the last call. */
    fun takeEvents(): List<ConversationEvent> = events.toList().also { events.clear() }

    fun toolResults(): List<JsonObject> = transport.sent.filter { it.string("type") == "client_tool.result" }
}

// ---- JSON comparison ----

/** Structural equality. Numbers compare by value, so `21` and `21.0` are the same. */
internal fun sameJson(expected: JsonElement, actual: JsonElement): Boolean = when {
    expected is JsonNull || actual is JsonNull -> expected is JsonNull && actual is JsonNull
    expected is JsonObject && actual is JsonObject ->
        expected.keys == actual.keys && expected.all { (key, value) -> sameJson(value, actual.getValue(key)) }
    expected is JsonArray && actual is JsonArray ->
        expected.size == actual.size && expected.indices.all { sameJson(expected[it], actual[it]) }
    expected is JsonPrimitive && actual is JsonPrimitive ->
        if (expected.isString || actual.isString) {
            expected.isString && actual.isString && expected.content == actual.content
        } else {
            val a = expected.doubleOrNull
            val b = actual.doubleOrNull
            if (a != null && b != null) a == b else expected.content == actual.content
        }
    else -> false
}

internal fun assertSameJson(expected: JsonElement, actual: JsonElement, what: String = "JSON") {
    if (!sameJson(expected, actual)) {
        throw AssertionError("$what differs.\n  expected: $expected\n  actual:   $actual")
    }
}

/** An event in the shape the shared fixtures use: the TypeScript event name and its payload. */
internal fun ConversationEvent.toFixture(): Pair<String, JsonElement> = when (this) {
    is ConversationEvent.Connect -> "connect" to buildJsonObject { put("sessionId", sessionId) }
    is ConversationEvent.Disconnect -> "disconnect" to buildJsonObject { put("reason", reason.wireValue) }
    is ConversationEvent.StatusChange -> "statusChange" to JsonPrimitive(status.name.lowercase())
    is ConversationEvent.ModeChange -> "modeChange" to JsonPrimitive(mode.name.lowercase())
    is ConversationEvent.UserTranscript -> "userTranscript" to buildJsonObject {
        put("segmentId", segmentId)
        put("text", text)
        put("final", isFinal)
    }
    is ConversationEvent.AgentResponseDelta -> "agentResponseDelta" to buildJsonObject {
        put("segmentId", segmentId)
        put("delta", delta)
        put("text", text)
    }
    is ConversationEvent.AgentResponse -> "agentResponse" to buildJsonObject {
        put("segmentId", segmentId)
        put("text", text)
    }
    is ConversationEvent.Message -> "message" to buildJsonObject {
        put("role", role.name.lowercase())
        put("text", text)
    }
    is ConversationEvent.ToolCallStarted -> "toolCallStarted" to buildJsonObject {
        put("callId", callId)
        put("toolName", toolName)
        put("source", source.value)
        put("input", input)
        put("inputTruncated", inputTruncated)
    }
    is ConversationEvent.ToolCallCompleted -> "toolCallCompleted" to buildJsonObject {
        put("callId", callId)
        put("toolName", toolName)
        put("source", source.value)
        put("output", output)
        put("outputTruncated", outputTruncated)
    }
    is ConversationEvent.ToolCallFailed -> "toolCallFailed" to buildJsonObject {
        put("callId", callId)
        put("toolName", toolName)
        put("source", source.value)
        put("error", error)
        httpStatus?.let { put("httpStatus", it) }
    }
    is ConversationEvent.Error -> "error" to buildJsonObject {
        put("code", error.code.wireValue)
        error.stage?.let { put("stage", it.wireValue) }
        error.recovered?.let { put("recovered", it) }
    }
}
