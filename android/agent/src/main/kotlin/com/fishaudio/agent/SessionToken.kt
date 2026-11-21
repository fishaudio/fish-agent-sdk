package com.fishaudio.agent

import com.fishaudio.agent.internal.JsonValues
import com.fishaudio.agent.internal.string
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * What your backend gets back from `POST /v1/agent/sessions`. Pass the
 * response body to [fromJson] as it is; do not pick fields out of it.
 *
 * [transport] is kept as text on purpose: a transport this SDK version does
 * not know fails the start with [FishAgentErrorCode.UNSUPPORTED_TRANSPORT],
 * which tells the user to upgrade, instead of failing to parse.
 */
public class SessionToken(
    public val transport: String,
    public val sessionId: String,
    /** The deadline to join, in ISO 8601. Not the length of the call. */
    public val expiresAt: String? = null,
    public val maxDurationSeconds: Int? = null,
    public val livekitUrl: String? = null,
    public val token: String? = null,
) {
    override fun toString(): String = "SessionToken(transport=$transport, sessionId=$sessionId)"

    public companion object {
        /**
         * Reads the JSON your backend returned. Fields this SDK does not know are ignored.
         *
         * @throws IllegalArgumentException when the text is not a JSON object
         * or has no `transport` or `session_id`.
         */
        @JvmStatic
        public fun fromJson(json: String): SessionToken {
            val body = JsonValues.parseObject(json)
                ?: throw IllegalArgumentException("A session token must be a JSON object")
            return SessionToken(
                transport = body.string("transport")
                    ?: throw IllegalArgumentException("The session token has no `transport`"),
                sessionId = body.string("session_id")
                    ?: throw IllegalArgumentException("The session token has no `session_id`"),
                expiresAt = body.string("expires_at"),
                maxDurationSeconds = (body["max_duration_seconds"] as? JsonPrimitive)
                    ?.takeUnless { it.isString }?.intOrNull,
                livekitUrl = body.string("livekit_url"),
                token = body.string("token"),
            )
        }
    }
}
