package com.fishaudio.agent.internal

import com.fishaudio.agent.MessageRole
import com.fishaudio.agent.SessionToken
import kotlinx.serialization.json.JsonObject

// The seam between the session and the realtime connection. The session speaks
// only this interface, so LiveKit vocabulary stops at the implementation and
// the session is tested against a fake. Not part of the public API.
// Port of packages/client/src/transport/types.ts, without its browser-only parts.

internal enum class TransportConnectionState {
    CONNECTED,
    RECONNECTING,
    DISCONNECTED,
}

/** Reasons a transport gives with [TransportConnectionState.DISCONNECTED] that the session acts on. */
internal object DisconnectReasons {
    /** The agent participant left while the room stayed open. */
    const val AGENT_LEFT = "AGENT_LEFT"
    const val ROOM_DELETED = "ROOM_DELETED"
    const val ROOM_CLOSED = "ROOM_CLOSED"
}

/** One update of a transcript segment. [text] is the whole segment so far: updates replace, never append. */
internal class TranscriptionSegmentUpdate(
    val segmentId: String,
    val role: MessageRole,
    val text: String,
    val isFinal: Boolean,
)

/**
 * Called by the transport. Every call arrives on the session's dispatcher,
 * one at a time, in the order things happened: the session keeps no locks.
 */
internal interface TransportCallbacks {
    /** One message from the `agent-event` topic, already parsed. */
    fun onAgentEvent(message: JsonObject)

    /** The agent set `fish.agent.ready`. Sticky: a client that joins late still gets it. */
    fun onAgentReady()

    /** The agent's `lk.agent.state`. Sticky. Proves the agent joined, not that it is ready. */
    fun onAgentState(state: String)

    fun onTranscription(update: TranscriptionSegmentUpdate)

    fun onConnectionState(state: TransportConnectionState, reason: String? = null)
}

internal class TransportConnectOptions(
    val callbacks: TransportCallbacks,
    /** Capture and publish the microphone while connecting. */
    val microphone: Boolean,
)

internal interface Transport {
    /**
     * Joins the session. Returns once the room is connected and, when
     * [TransportConnectOptions.microphone] is set, the microphone is published.
     * The transport also reports audio readiness to the runtime by itself (see
     * docs/protocol.md, section 2): the session has no part in that handshake.
     */
    suspend fun connect(sessionToken: SessionToken, options: TransportConnectOptions)

    suspend fun disconnect()

    suspend fun setMicEnabled(enabled: Boolean)

    /** Sends one message on `client-event`, reliably. Throws when it cannot be sent. */
    suspend fun sendClientEvent(message: JsonObject)
}
