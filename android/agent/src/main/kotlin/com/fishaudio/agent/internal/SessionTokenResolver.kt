package com.fishaudio.agent.internal

import com.fishaudio.agent.FishAgentError
import com.fishaudio.agent.FishAgentErrorCode
import com.fishaudio.agent.SessionAuth
import com.fishaudio.agent.SessionOptions
import com.fishaudio.agent.SessionToken
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

internal const val DEFAULT_SERVER_URL = "https://api.fish.audio"

/**
 * Turns a [SessionAuth] into a session token the SDK can join with: checks a
 * token the app passed in, or creates a session for a public agent.
 * Port of packages/client/src/sessionToken.ts.
 */
internal class SessionTokenResolver(
    private val http: HttpClient,
    /** Current time in epoch ms. */
    private val now: () -> Long,
    /** The device's IANA timezone, sent as a hint. */
    private val clientTimezone: () -> String?,
    /** The `X-Fish-SDK` header value, for example `agent-android/1.2.0`. */
    private val sdkHeader: String,
) {
    suspend fun resolve(auth: SessionAuth, options: SessionOptions): SessionToken = when (auth) {
        is SessionAuth.Token -> validate(auth.sessionToken)
        is SessionAuth.AgentId -> validate(createPublicSession(auth.agentId, options))
    }

    /** The transport is checked first: an SDK that is too old should say so, whatever else is wrong. */
    fun validate(token: SessionToken): SessionToken {
        if (token.transport != Protocol.TRANSPORT_LIVEKIT) {
            throw FishAgentError(
                FishAgentErrorCode.UNSUPPORTED_TRANSPORT,
                "Session token uses transport \"${token.transport}\" which this SDK version does not " +
                    "support; please upgrade the Fish Agent SDK",
            )
        }
        // A deadline that cannot be read does not block the call: the server enforces it anyway.
        val expiresAt = token.expiresAt?.let(Iso8601::parseEpochMs)
        if (expiresAt != null && expiresAt <= now()) {
            throw FishAgentError(
                FishAgentErrorCode.SESSION_EXPIRED,
                "The session token's join deadline has passed; request a new session",
            )
        }
        return token
    }

    private suspend fun createPublicSession(agentId: String, options: SessionOptions): SessionToken {
        val serverUrl = (options.serverUrl ?: DEFAULT_SERVER_URL).removeSuffix("/")
        val headers = buildMap {
            put("Content-Type", "application/json")
            put("X-Fish-SDK", sdkHeader)
            // An app sends no Origin by itself; a public agent that restricts origins needs one.
            if (!options.origin.isNullOrEmpty()) put("Origin", options.origin)
        }
        val response = try {
            http.post("$serverUrl/v1/agent/sessions", headers, JsonValues.encode(requestBody(agentId, options)))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (cause: IOException) {
            throw FishAgentError(
                FishAgentErrorCode.SESSION_REQUEST_FAILED,
                "Could not reach the session endpoint",
                cause = cause,
            )
        }
        if (response.status !in 200..299) {
            throw sessionError(response, originSent = !options.origin.isNullOrEmpty())
        }
        return try {
            SessionToken.fromJson(response.body)
        } catch (cause: IllegalArgumentException) {
            throw FishAgentError(
                FishAgentErrorCode.SESSION_REQUEST_FAILED,
                "The session endpoint returned a response this SDK cannot read",
                statusCode = response.status,
                cause = cause,
            )
        }
    }

    internal fun requestBody(agentId: String, options: SessionOptions): JsonObject = buildJsonObject {
        put("agent_id", agentId)
        options.timezone?.takeIf { it.isNotEmpty() }?.let { put("timezone", it) }
        clientTimezone()?.takeIf { it.isNotEmpty() }?.let { put("client_timezone", it) }
        options.context?.currentTime?.let { currentTime ->
            putJsonObject("context") { put("current_time", currentTime) }
        }
        val language = options.language?.takeIf { it.isNotEmpty() }
        val overrides = options.overrides
        if (language != null || overrides != null) {
            putJsonObject("overrides") {
                // `language` is short for overrides.language; an explicit override wins.
                (overrides?.language ?: language)?.let { put("language", it) }
                overrides?.firstMessage?.let { put("first_message", it) }
                overrides?.firstMessagePrompt?.let { put("first_message_prompt", it) }
                overrides?.systemPrompt?.let { put("system_prompt", it) }
                overrides?.voiceId?.let { put("voice_id", it) }
                overrides?.asrModel?.let { model -> putJsonObject("asr") { put("model", model) } }
            }
        }
        options.dynamicVariables?.let { put("dynamic_variables", JsonValues.toElement(it)) }
        options.endUserId?.takeIf { it.isNotEmpty() }?.let { put("end_user_id", it) }
        options.metadata?.let { put("metadata", JsonValues.toElement(it)) }
        options.toolEvents?.let { put("tool_events", it) }
    }

    private fun sessionError(response: HttpResponse, originSent: Boolean): FishAgentError {
        val body = JsonValues.parseObject(response.body)
        val message = body?.string("message") ?: body?.string("error")
            ?: "Session request failed with HTTP ${response.status}"
        val status = response.status
        // 409 alone is ambiguous (the server also uses it for an unpublished
        // agent); only the coded arm means "this SDK is too old".
        if (status == 409 && body?.string("code") == "unsupported_transport") {
            return FishAgentError(
                FishAgentErrorCode.UNSUPPORTED_TRANSPORT,
                "$message; please upgrade the Fish Agent SDK",
                statusCode = status,
            )
        }
        if (status == 402) {
            return FishAgentError(FishAgentErrorCode.INSUFFICIENT_CREDIT, message, statusCode = status)
        }
        if (status == 403) {
            if (!message.contains("origin", ignoreCase = true)) {
                return FishAgentError(FishAgentErrorCode.AGENT_NOT_PUBLIC, message, statusCode = status)
            }
            val hint = if (originSent) {
                ""
            } else {
                "; the agent restricts origins, so pass `origin` with one of its allowed origins"
            }
            return FishAgentError(FishAgentErrorCode.ORIGIN_FORBIDDEN, message + hint, statusCode = status)
        }
        return FishAgentError(FishAgentErrorCode.SESSION_REQUEST_FAILED, message, statusCode = status)
    }
}
