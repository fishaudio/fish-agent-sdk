package com.fishaudio.agent.internal

import com.fishaudio.agent.SessionToken
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class ValuesTest {
    // ---- Iso8601 ----

    @Test
    fun `reads the formats the API uses`() {
        val base = 1_577_836_800_000L // 2020-01-01T00:00:00Z
        assertEquals(base, Iso8601.parseEpochMs("2020-01-01T00:00:00Z"))
        assertEquals(base + 123, Iso8601.parseEpochMs("2020-01-01T00:00:00.123Z"))
        assertEquals(base + 120, Iso8601.parseEpochMs("2020-01-01T00:00:00.12Z"))
        assertEquals(base + 123, Iso8601.parseEpochMs("2020-01-01T00:00:00.123456Z"))
        assertEquals(base, Iso8601.parseEpochMs("2020-01-01T08:00:00+08:00"))
        assertEquals(base, Iso8601.parseEpochMs("2019-12-31T19:00:00-0500"))
    }

    @Test
    fun `returns null for anything else`() {
        for (text in listOf("", "not-a-date", "2020-01-01", "2020-01-01T00:00:00", "2020-13-01T00:00:00Z", "2020-02-30T00:00:00Z")) {
            assertNull(text, Iso8601.parseEpochMs(text))
        }
    }

    // ---- JSON values ----

    @Test
    fun `plain values survive a round trip through JSON`() {
        val value = mapOf(
            "text" to "hi/there",
            "count" to 2L,
            "ratio" to 0.5,
            "ok" to true,
            "nothing" to null,
            "list" to listOf(1L, "two", null, mapOf("deep" to false)),
        )
        assertEquals(value, JsonValues.fromElement(Json.parseToJsonElement(JsonValues.encode(JsonValues.toElement(value)))))
    }

    @Test
    fun `whole numbers come back as Long and fractions as Double`() {
        val parsed = JsonValues.fromObject(Json.parseToJsonElement("""{"a":3,"b":3.0,"c":3.5,"d":"3"}""").jsonObject)
        assertEquals(3L, parsed["a"])
        assertEquals(3.0, parsed["b"])
        assertEquals(3.5, parsed["c"])
        assertEquals("3", parsed["d"])
    }

    @Test
    fun `rejects values JSON cannot hold`() {
        assertThrows(IllegalArgumentException::class.java) { JsonValues.toElement(Any()) }
        assertThrows(IllegalArgumentException::class.java) { JsonValues.toElement(Double.NaN) }
        assertThrows(IllegalArgumentException::class.java) { JsonValues.toElement(Float.POSITIVE_INFINITY) }
        assertThrows(IllegalArgumentException::class.java) { JsonValues.toElement(mapOf(1 to "one")) }
        assertThrows(IllegalArgumentException::class.java) { JsonValues.toElement(listOf(listOf(Any()))) }
    }

    @Test
    fun `typed readers accept only the matching JSON type`() {
        val body = Json.parseToJsonElement("""{"s":"x","b":true,"n":30,"bs":"true","ns":"30","z":null}""").jsonObject
        assertEquals("x", body.string("s"))
        assertNull(body.string("n"))
        assertNull(body.string("z"))
        assertEquals(true, body.boolean("b"))
        assertNull(body.boolean("bs"))
        assertNull(body.boolean("z"))
        assertEquals(30.0, body.number("n"))
        assertNull(body.number("ns"))
        assertNull(body.number("b"))
        assertNull(body.number("missing"))
    }

    // ---- SessionToken ----

    @Test
    fun `reads a backend response as it is`() {
        val token = SessionToken.fromJson(
            """{"transport":"livekit","session_id":"sess-9","expires_at":"2099-01-01T00:00:00Z",
               "max_duration_seconds":1800,"livekit_url":"wss://x","token":"jwt","region":"ap"}""",
        )
        assertEquals("livekit", token.transport)
        assertEquals("sess-9", token.sessionId)
        assertEquals(1800, token.maxDurationSeconds)
        assertEquals("wss://x", token.livekitUrl)
        assertEquals("jwt", token.token)
    }

    @Test
    fun `refuses text that is not a session token`() {
        for (text in listOf("", "[]", "\"token\"", """{"session_id":"s"}""", """{"transport":"livekit"}""")) {
            assertThrows(text, IllegalArgumentException::class.java) { SessionToken.fromJson(text) }
        }
    }

    @Test
    fun `does not print the join token`() {
        val token = SessionToken.fromJson("""{"transport":"livekit","session_id":"s","token":"secret-jwt"}""")
        assertEquals(false, token.toString().contains("secret-jwt"))
    }

    // ---- tool timeout ----

    @Test
    fun `the timeout margin is the smaller of one second and ten percent`() {
        assertEquals(29_000L, ClientToolDispatcher.timeoutFor(30_000.0, 15_000))
        assertEquals(4_500L, ClientToolDispatcher.timeoutFor(5_000.0, 15_000))
        assertEquals(15_000L, ClientToolDispatcher.timeoutFor(null, 15_000))
        assertEquals(15_000L, ClientToolDispatcher.timeoutFor(Double.POSITIVE_INFINITY, 15_000))
        assertEquals(15_000L, ClientToolDispatcher.timeoutFor(-1.0, 15_000))
    }
}
