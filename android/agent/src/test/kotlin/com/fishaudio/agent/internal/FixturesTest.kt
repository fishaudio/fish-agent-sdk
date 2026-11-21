package com.fishaudio.agent.internal

import com.fishaudio.agent.ClientToolHandler
import com.fishaudio.agent.ConversationEvent
import com.fishaudio.agent.FishAgentError
import com.fishaudio.agent.SessionAuth
import com.fishaudio.agent.SessionContext
import com.fishaudio.agent.SessionOptions
import com.fishaudio.agent.SessionOverrides
import com.fishaudio.agent.SessionToken
import java.io.File
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs the conformance fixtures in packages/protocol/fixtures, the same files
 * the TypeScript client runs. See the README there for the format.
 *
 * The runner is strict on purpose: an unknown key or kind fails the test
 * instead of being skipped, so this file has to be updated with the fixtures.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class FixturesTest {
    private val root = File(checkNotNull(System.getProperty("fishAgent.fixtures")) { "fishAgent.fixtures is not set" })

    private class Case(val where: String, val json: JsonObject) {
        val name: String = json.getValue("name").jsonPrimitive.content
        operator fun get(key: String): JsonElement? = json[key]
        fun obj(key: String): JsonObject = json.getValue(key).jsonObject
    }

    private fun onlyKeys(value: JsonObject, where: String, vararg allowed: String) {
        val unknown = value.keys - allowed.toSet()
        check(unknown.isEmpty()) { "$where: unknown key(s) $unknown; update this runner" }
    }

    /** Runs [block] for every case in a fixture file and reports all failing cases together. */
    private fun forEachCase(path: String, block: suspend TestScope.(Case) -> Unit) {
        val file = Json.parseToJsonElement(File(root, path).readText()).jsonObject
        onlyKeys(file, path, "description", "cases")
        val cases = file.getValue("cases").jsonArray.map { Case(path, it.jsonObject) }
        assertEquals("$path: case names must be unique", cases.size, cases.map { it.name }.toSet().size)
        assertTrue("$path has no cases", cases.isNotEmpty())
        val failures = cases.mapNotNull { case ->
            try {
                runTest { block(case) }
                null
            } catch (error: Throwable) {
                "  ✗ ${case.name}\n      ${error.toString().replace("\n", "\n      ")}"
            }
        }
        if (failures.isNotEmpty()) {
            throw AssertionError("$path: ${failures.size} of ${cases.size} cases failed\n${failures.joinToString("\n")}")
        }
    }

    private val placeholders = mapOf(
        "{{client_timezone}}" to TEST_TIMEZONE,
        "{{sdk}}" to TEST_SDK_HEADER,
    )

    /** Replaces whole-string placeholders anywhere in an expected value. */
    private fun fill(value: JsonElement): JsonElement = when (value) {
        is JsonObject -> JsonObject(value.mapValues { fill(it.value) })
        is JsonArray -> JsonArray(value.map(::fill))
        is JsonPrimitive -> if (value.isString) JsonPrimitive(placeholders[value.content] ?: value.content) else value
    }

    private fun checkMessage(message: String, expected: JsonObject) {
        expected["message"]?.let { assertEquals(it.jsonPrimitive.content, message) }
        expected["messageStartsWith"]?.let { assertTrue(message, message.startsWith(it.jsonPrimitive.content)) }
        expected["messageContains"]?.let { assertTrue(message, message.contains(it.jsonPrimitive.content)) }
    }

    // ---- messages/agent-events.json ----

    @Test
    fun agentEvents() = forEachCase("messages/agent-events.json") { case ->
        onlyKeys(case.json, case.where, "name", "message", "expect")
        val harness = SessionHarness(this)
        harness.start()
        harness.takeEvents()
        harness.transport.agent(case.obj("message"))
        harness.settle()
        val seen = harness.takeEvents().map { it.toFixture() }

        val expected = case.obj("expect")
        when {
            "event" in expected -> {
                onlyKeys(expected, case.where, "event", "payload")
                assertEquals(listOf(expected.getValue("event").jsonPrimitive.content), seen.map { it.first })
                assertSameJson(expected.getValue("payload"), seen.single().second, "payload")
            }
            "error" in expected -> {
                onlyKeys(expected, case.where, "error")
                onlyKeys(expected.getValue("error").jsonObject, case.where, "code", "stage", "recovered")
                assertEquals(listOf("error"), seen.map { it.first })
                // A key left out of the fixture means the field is absent on the error.
                assertSameJson(expected.getValue("error"), seen.single().second, "error")
            }
            "ignored" in expected -> {
                onlyKeys(expected, case.where, "ignored")
                assertEquals(JsonPrimitive(true), expected["ignored"])
                assertEquals(emptyList<Pair<String, JsonElement>>(), seen)
                assertEquals(emptyList<JsonObject>(), harness.transport.sent)
            }
            "endReasonAfterDisconnect" in expected -> {
                onlyKeys(expected, case.where, "endReasonAfterDisconnect")
                assertEquals(emptyList<Pair<String, JsonElement>>(), seen)
                harness.transport.state(TransportConnectionState.DISCONNECTED)
                assertEquals(
                    expected.getValue("endReasonAfterDisconnect").jsonPrimitive.content,
                    harness.session.endReason?.wireValue,
                )
            }
            else -> error("${case.where}: \"${case.name}\" has no expectation this runner knows")
        }
    }

    // ---- messages/client-events.json ----

    @Test
    fun clientEvents() = forEachCase("messages/client-events.json") { case ->
        onlyKeys(case.json, case.where, "name", "call", "sent")
        val harness = SessionHarness(this)
        val session = harness.start()
        val call = case.obj("call")
        when (val method = call.getValue("method").jsonPrimitive.content) {
            "sendUserMessage" -> {
                onlyKeys(call, case.where, "method", "text", "audio")
                val text = call.getValue("text").jsonPrimitive.content
                when (val audio = call["audio"]) {
                    null -> session.sendUserMessage(text)
                    else -> session.sendUserMessage(text, audio = audio.jsonPrimitive.content.toBooleanStrict())
                }
            }
            "sendUserActivity" -> {
                onlyKeys(call, case.where, "method")
                session.sendUserActivity()
            }
            "interrupt" -> {
                onlyKeys(call, case.where, "method")
                session.interrupt()
            }
            "end" -> {
                onlyKeys(call, case.where, "method")
                session.end()
            }
            else -> error("${case.where}: unknown method \"$method\"; update this runner")
        }
        harness.settle()
        assertSameJson(case.json.getValue("sent"), JsonArray(harness.transport.sent), "sent messages")
    }

    // ---- session/request.json ----

    private fun optionsFrom(json: JsonObject, where: String): SessionOptions {
        onlyKeys(
            json, where,
            "agentId", "origin", "serverUrl", "language", "timezone", "context", "overrides",
            "dynamicVariables", "endUserId", "metadata", "toolEvents",
        )
        val overrides = json["overrides"]?.jsonObject?.let { o ->
            onlyKeys(o, where, "first_message", "first_message_prompt", "system_prompt", "voice_id", "language", "asr")
            SessionOverrides(
                firstMessage = o.string("first_message"),
                firstMessagePrompt = o.string("first_message_prompt"),
                systemPrompt = o.string("system_prompt"),
                voiceId = o.string("voice_id"),
                language = o.string("language"),
                asrModel = (o["asr"] as? JsonObject)?.string("model"),
            )
        }
        val context = json["context"]?.jsonObject?.let { c ->
            onlyKeys(c, where, "currentTime")
            SessionContext(currentTime = c.boolean("currentTime"))
        }
        @Suppress("UNCHECKED_CAST")
        return SessionOptions(
            origin = json.string("origin"),
            serverUrl = json.string("serverUrl"),
            language = json.string("language"),
            timezone = json.string("timezone"),
            context = context,
            overrides = overrides,
            dynamicVariables = json["dynamicVariables"]?.jsonObject?.let { JsonValues.fromObject(it) as Map<String, Any> },
            endUserId = json.string("endUserId"),
            metadata = json["metadata"]?.jsonObject?.let(JsonValues::fromObject),
            toolEvents = json.boolean("toolEvents"),
        )
    }

    @Test
    fun sessionRequest() = forEachCase("session/request.json") { case ->
        onlyKeys(case.json, case.where, "name", "options", "expect")
        val expected = case.obj("expect")
        onlyKeys(expected, case.where, "url", "headers", "absentHeaders", "body")
        val options = case.obj("options")
        val http = FakeHttp()

        resolver(http).resolve(SessionAuth.AgentId(options.getValue("agentId").jsonPrimitive.content), optionsFrom(options, case.where))

        val request = http.requests.single()
        assertEquals(expected.getValue("url").jsonPrimitive.content, request.url)
        for ((name, value) in expected.getValue("headers").jsonObject) {
            assertEquals("header $name", fill(value).jsonPrimitive.content, request.headers[name])
        }
        for (name in expected.getValue("absentHeaders").jsonArray) {
            assertTrue("header $name must not be sent", name.jsonPrimitive.content !in request.headers)
        }
        assertSameJson(fill(expected.getValue("body")), Json.parseToJsonElement(request.body), "request body")
    }

    // ---- session/errors.json ----

    @Test
    fun sessionErrors() = forEachCase("session/errors.json") { case ->
        onlyKeys(case.json, case.where, "name", "response", "options", "expect")
        val expected = case.obj("expect")
        onlyKeys(expected, case.where, "code", "statusCode", "message", "messageStartsWith", "messageContains")
        val options = case["options"]?.jsonObject ?: JsonObject(emptyMap())
        onlyKeys(options, case.where, "origin")
        val response = case.obj("response")
        val http = when {
            "networkError" in response -> {
                onlyKeys(response, case.where, "networkError")
                FakeHttp(networkError = true)
            }
            "json" in response -> {
                onlyKeys(response, case.where, "status", "json")
                FakeHttp(response.getValue("status").jsonPrimitive.long.toInt(), response.getValue("json").toString())
            }
            "text" in response -> {
                onlyKeys(response, case.where, "status", "text")
                FakeHttp(response.getValue("status").jsonPrimitive.long.toInt(), response.getValue("text").jsonPrimitive.content)
            }
            else -> error("${case.where}: \"${case.name}\" has no response this runner knows")
        }

        val failure = runCatching {
            resolver(http).resolve(SessionAuth.AgentId("agent-1"), SessionOptions(origin = options.string("origin")))
        }.exceptionOrNull()

        assertTrue("expected a FishAgentError, got $failure", failure is FishAgentError)
        failure as FishAgentError
        assertEquals(expected.getValue("code").jsonPrimitive.content, failure.code.wireValue)
        val status = expected.getValue("statusCode")
        assertEquals(if (status is JsonNull) null else status.jsonPrimitive.long.toInt(), failure.statusCode)
        checkMessage(failure.message, expected)
    }

    // ---- session/tokens.json ----

    @Test
    fun sessionTokens() = forEachCase("session/tokens.json") { case ->
        onlyKeys(case.json, case.where, "name", "token", "expiresAtOffsetMs", "expect")
        val expected = case.obj("expect")
        onlyKeys(expected, case.where, "ok", "error", "messageContains")
        val tokenJson = buildJsonObject {
            for ((key, value) in case.obj("token")) put(key, value)
            case["expiresAtOffsetMs"]?.let { offset ->
                val at = NOW_MS + offset.jsonPrimitive.long
                put("expires_at", java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
                    .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
                    .format(java.util.Date(at)))
            }
        }
        // Through the same entry point an app uses for its backend's response.
        val token = SessionToken.fromJson(tokenJson.toString())

        val outcome = runCatching { resolver().resolve(SessionAuth.Token(token), SessionOptions()) }

        when {
            "ok" in expected -> {
                onlyKeys(expected, case.where, "ok")
                assertEquals(JsonPrimitive(true), expected["ok"])
                assertTrue("expected the token to be accepted, got ${outcome.exceptionOrNull()}", outcome.getOrNull() === token)
            }
            "error" in expected -> {
                val failure = outcome.exceptionOrNull()
                assertTrue("expected a FishAgentError, got $failure", failure is FishAgentError)
                failure as FishAgentError
                assertEquals(expected.getValue("error").jsonPrimitive.content, failure.code.wireValue)
                checkMessage(failure.message, expected)
            }
            else -> error("${case.where}: \"${case.name}\" has no expectation this runner knows")
        }
    }

    // ---- tools/timeouts.json ----

    @Test
    fun toolTimeouts() = forEachCase("tools/timeouts.json") { case ->
        onlyKeys(case.json, case.where, "name", "call", "fallbackMs", "expectMs")
        onlyKeys(case.obj("call"), case.where, "timeoutMs")
        val expectMs = case.json.getValue("expectMs").jsonPrimitive.long
        val harness = SessionHarness(this)
        harness.start(
            SessionOptions(
                clientTools = mapOf("slow_tool" to ClientToolHandler { _, _ -> awaitCancellation() }),
                clientToolTimeoutMs = case.json.getValue("fallbackMs").jsonPrimitive.long,
            ),
        )
        harness.transport.agent(
            buildJsonObject {
                put("type", "client_tool.call")
                put("callId", "call-timeout")
                put("toolName", "slow_tool")
                put("params", JsonObject(emptyMap()))
                put("expectsResponse", true)
                for ((key, value) in case.obj("call")) put(key, value)
            },
        )

        advanceTimeBy(expectMs - 1)
        harness.settle()
        assertEquals("answered before the timeout", emptyList<JsonObject>(), harness.toolResults())
        advanceTimeBy(1)
        harness.settle()
        val reply = harness.toolResults().single()
        assertEquals("call-timeout", reply.string("callId"))
        assertEquals(true, reply.boolean("isError"))
    }

    // ---- tools/results.json ----

    /** Longer than any timeout a fixture uses, so a tool that hangs has timed out by then. */
    private val pastEveryTimeoutMs = 20_000L

    private fun handlerFor(handler: JsonObject, where: String): ClientToolHandler? =
        when (val kind = handler.getValue("kind").jsonPrimitive.content) {
            "returns" -> {
                onlyKeys(handler, where, "kind", "value")
                val value = JsonValues.fromElement(handler.getValue("value"))
                ClientToolHandler { _, _ -> value }
            }
            "returnsNothing" -> {
                onlyKeys(handler, where, "kind")
                ClientToolHandler { _, _ -> null }
            }
            "returnsStringOfLength" -> {
                onlyKeys(handler, where, "kind", "length")
                val text = "a".repeat(handler.getValue("length").jsonPrimitive.long.toInt())
                ClientToolHandler { _, _ -> text }
            }
            "echoesParams" -> {
                onlyKeys(handler, where, "kind")
                ClientToolHandler { params, _ -> params }
            }
            "echoesContext" -> {
                onlyKeys(handler, where, "kind")
                ClientToolHandler { _, context -> mapOf("callId" to context.callId, "toolName" to context.toolName) }
            }
            "throws" -> {
                onlyKeys(handler, where, "kind", "message")
                val message = handler.getValue("message").jsonPrimitive.content
                ClientToolHandler { _, _ -> throw IllegalStateException(message) }
            }
            "hangs" -> {
                onlyKeys(handler, where, "kind")
                ClientToolHandler { _, _ -> awaitCancellation() }
            }
            "unregistered" -> {
                onlyKeys(handler, where, "kind")
                null
            }
            else -> error("$where: unknown handler kind \"$kind\"; update this runner")
        }

    @Test
    fun toolResults() = forEachCase("tools/results.json") { case ->
        onlyKeys(case.json, case.where, "name", "call", "handler", "expect")
        val expected = case.obj("expect")
        onlyKeys(expected, case.where, "reply", "result", "resultAbsent", "errorCode")
        val call = case.obj("call")
        val handler = handlerFor(case.obj("handler"), case.where)
        val harness = SessionHarness(this)
        harness.start(
            SessionOptions(
                clientTools = handler?.let { mapOf(call.getValue("toolName").jsonPrimitive.content to it) } ?: emptyMap(),
            ),
        )
        harness.takeEvents()

        harness.transport.agent(call)
        advanceTimeBy(pastEveryTimeoutMs)
        harness.settle()

        val errorCodes = harness.takeEvents().filterIsInstance<ConversationEvent.Error>().map { it.error.code.wireValue }
        val expectedCode = expected.getValue("errorCode")
        assertEquals(if (expectedCode is JsonNull) emptyList() else listOf(expectedCode.jsonPrimitive.content), errorCodes)

        val replies = harness.toolResults()
        when (val kind = expected.getValue("reply").jsonPrimitive.content) {
            "none" -> {
                onlyKeys(expected, case.where, "reply", "errorCode")
                assertEquals(emptyList<JsonObject>(), replies)
            }
            "result" -> {
                val reply = replies.single()
                assertEquals(call.string("callId"), reply.string("callId"))
                assertTrue("a result must not carry isError", "isError" !in reply)
                when {
                    "resultAbsent" in expected -> {
                        assertEquals(JsonPrimitive(true), expected["resultAbsent"])
                        assertTrue("there must be no result field", "result" !in reply)
                    }
                    "result" in expected -> assertSameJson(expected.getValue("result"), reply.getValue("result"), "result")
                    else -> assertTrue("there must be a result field", "result" in reply)
                }
            }
            "error" -> {
                onlyKeys(expected, case.where, "reply", "result", "errorCode")
                val reply = replies.single()
                assertEquals(call.string("callId"), reply.string("callId"))
                assertEquals(true, reply.boolean("isError"))
                when (val result = expected["result"]) {
                    null -> assertTrue("an error result carries text", reply.string("result") != null)
                    else -> assertSameJson(result, reply.getValue("result"), "result")
                }
            }
            else -> error("${case.where}: unknown reply \"$kind\"; update this runner")
        }
    }

    // ---- scenarios/session.json ----

    @Test
    fun sessionScenarios() = forEachCase("scenarios/session.json") { case ->
        onlyKeys(case.json, case.where, "name", "start", "steps")
        val start = case["start"]?.jsonObject ?: JsonObject(emptyMap())
        onlyKeys(start, case.where, "agent")
        val harness = SessionHarness(this)
        val session = harness.start(agentReady = false)
        when (val agent = start.string("agent") ?: "ready") {
            "ready" -> {
                harness.transport.agentState("initializing")
                harness.transport.ready()
            }
            "joined" -> harness.transport.agentState("initializing")
            "absent" -> Unit
            else -> error("${case.where}: unknown start.agent \"$agent\"; update this runner")
        }
        harness.settle()
        var sentChecked = 0

        case.json.getValue("steps").jsonArray.forEachIndexed { index, element ->
            val step = element.jsonObject
            val at = "${case.where}: \"${case.name}\" step ${index + 1}"
            val action = step.string("do")
            val expectation = step.string("expect")
            when {
                action != null -> {
                    when (action) {
                        "agentState" -> {
                            onlyKeys(step, at, "do", "state")
                            harness.transport.agentState(step.string("state")!!)
                        }
                        "agentReady" -> {
                            onlyKeys(step, at, "do")
                            harness.transport.ready()
                        }
                        "agentEvent" -> {
                            onlyKeys(step, at, "do", "message")
                            harness.transport.agent(step.getValue("message").jsonObject)
                        }
                        "transcription" -> {
                            onlyKeys(step, at, "do", "role", "segmentId", "text", "final")
                            harness.transport.transcription(
                                segmentId = step.string("segmentId")!!,
                                role = when (val role = step.string("role")) {
                                    "user" -> com.fishaudio.agent.MessageRole.USER
                                    "agent" -> com.fishaudio.agent.MessageRole.AGENT
                                    else -> error("$at: unknown role \"$role\"")
                                },
                                text = step.string("text")!!,
                                isFinal = step.boolean("final")!!,
                            )
                        }
                        "connectionState" -> {
                            onlyKeys(step, at, "do", "state", "reason")
                            harness.transport.state(
                                when (val state = step.string("state")) {
                                    "connected" -> TransportConnectionState.CONNECTED
                                    "reconnecting" -> TransportConnectionState.RECONNECTING
                                    "disconnected" -> TransportConnectionState.DISCONNECTED
                                    else -> error("$at: unknown state \"$state\"")
                                },
                                step.string("reason"),
                            )
                        }
                        "sendUserMessage" -> {
                            onlyKeys(step, at, "do", "text", "audio")
                            session.sendUserMessage(step.string("text")!!, audio = step.boolean("audio") ?: false)
                        }
                        "sendUserActivity" -> {
                            onlyKeys(step, at, "do")
                            session.sendUserActivity()
                        }
                        "interrupt" -> {
                            onlyKeys(step, at, "do")
                            session.interrupt()
                        }
                        "end" -> {
                            onlyKeys(step, at, "do")
                            session.end()
                        }
                        "advance" -> {
                            onlyKeys(step, at, "do", "ms")
                            advanceTimeBy(step.getValue("ms").jsonPrimitive.long)
                        }
                        else -> error("$at: unknown action \"$action\"; update this runner")
                    }
                    harness.settle()
                }
                expectation == "sent" -> {
                    onlyKeys(step, at, "expect", "messages")
                    val since = harness.transport.sent.drop(sentChecked)
                    sentChecked = harness.transport.sent.size
                    assertSameJson(step.getValue("messages"), JsonArray(since), "$at: sent messages")
                }
                expectation == "events" -> {
                    onlyKeys(step, at, "expect", "of", "events")
                    val since = harness.takeEvents().map { it.toFixture() }
                    val expected = step.getValue("events")
                    if (expected is JsonPrimitive && expected.content == "any") {
                        onlyKeys(step, at, "expect", "events")
                    } else {
                        val of = step["of"]?.jsonArray?.map { it.jsonPrimitive.content }
                        val relevant = if (of == null) since else since.filter { it.first in of }
                        val actual = JsonArray(
                            relevant.map { (name, payload) ->
                                buildJsonObject {
                                    put("event", name)
                                    put("payload", payload)
                                }
                            },
                        )
                        assertSameJson(expected, actual, "$at: events")
                    }
                }
                expectation == "state" -> {
                    onlyKeys(step, at, "expect", "status", "mode", "endReason")
                    step.string("status")?.let { assertEquals(at, it, session.status.name.lowercase()) }
                    step.string("mode")?.let { assertEquals(at, it, session.mode.name.lowercase()) }
                    step["endReason"]?.let { expected ->
                        assertEquals(at, (expected as? JsonPrimitive)?.takeIf { it.isString }?.content, session.endReason?.wireValue)
                    }
                }
                expectation != null -> error("$at: unknown expectation \"$expectation\"; update this runner")
                else -> error("$at: a step needs \"do\" or \"expect\"")
            }
        }
    }
}
