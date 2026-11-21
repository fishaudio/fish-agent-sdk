package com.fishaudio.agent.internal

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The wire contract, as in packages/protocol/src/realtime.ts and
 * docs/protocol.md. Compatibility is additive-only: unknown message types and
 * unknown fields are ignored.
 */
internal object Protocol {
    const val AGENT_EVENT_TOPIC = "agent-event"
    const val CLIENT_EVENT_TOPIC = "client-event"

    /** Set by the agent, to epoch ms, once its pipeline is live. The only ready signal. */
    const val AGENT_READY_ATTRIBUTE = "fish.agent.ready"

    /** Set by the agent framework seconds before the ready attribute. Proves the agent joined. */
    const val AGENT_STATE_ATTRIBUTE = "lk.agent.state"

    /** Set by the client: "pending" after joining, then epoch ms once the agent's audio can be heard. */
    const val CLIENT_AUDIO_READY_ATTRIBUTE = "fish.client.audio_ready"
    const val CLIENT_AUDIO_READY_PENDING = "pending"

    const val TRANSPORT_LIVEKIT = "livekit"

    const val TRANSCRIPTION_TOPIC = "lk.transcription"
    const val SEGMENT_ID_ATTRIBUTE = "lk.segment_id"
    const val TRANSCRIPTION_FINAL_ATTRIBUTE = "lk.transcription_final"

    /**
     * Upper bound on a serialized `client_tool.result`. The data channel rejects
     * packets above 64 000 bytes; this leaves room for the packet envelope.
     */
    const val MAX_CLIENT_TOOL_RESULT_BYTES = 60_000
}

/** Messages the client sends on `client-event`. Field names are written out, never derived. */
internal object ClientMessages {
    /** `audio: false` asks for a text-only reply. With audio on, the field is left out. */
    fun userMessage(text: String, audio: Boolean): JsonObject = buildJsonObject {
        put("type", "user.message")
        put("text", text)
        if (!audio) put("audio", false)
    }

    fun userActivity(): JsonObject = buildJsonObject { put("type", "user.activity") }

    fun userInterrupt(): JsonObject = buildJsonObject { put("type", "user.interrupt") }

    fun userHangup(): JsonObject = buildJsonObject { put("type", "user.hangup") }

    fun audioReady(atEpochMs: Long): JsonObject = buildJsonObject {
        put("type", "client.audio_ready")
        put("at", atEpochMs)
    }

    /** [result] null leaves the field out; [isError] false leaves that out too. */
    fun toolResult(callId: String, result: JsonElement?, isError: Boolean): JsonObject = buildJsonObject {
        put("type", "client_tool.result")
        put("callId", callId)
        if (isError) put("isError", true)
        if (result != null) put("result", result)
    }
}
