package com.fishaudio.agent.internal

// The second seam, below the transport: a LiveKit room reduced to plain facts
// and commands. All of the transport's logic sits above it, where tests drive
// it with event sequences recorded from real calls (see
// src/test/resources/livekit-recordings). The real implementation is a thin
// wrapper and is checked on devices.

internal enum class RoomState {
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    DISCONNECTED,
}

/**
 * What the room reports. Every call arrives on the main dispatcher, one at a
 * time, in the order the room delivered things. Room events and text stream
 * callbacks come from different threads inside LiveKit; the adapter puts them
 * through one queue so that order is kept.
 */
internal interface RoomListener {
    fun onConnected()
    fun onReconnecting()
    fun onReconnected()

    /** [reason] is LiveKit's `DisconnectReason` name, for example `ROOM_DELETED`. */
    fun onDisconnected(reason: String)

    /** A remote participant joined, with the attributes it already carries. */
    fun onParticipantConnected(attributes: Map<String, String>)
    fun onParticipantDisconnected()

    /** [changed] holds only the attributes that changed. */
    fun onAttributesChanged(isLocal: Boolean, changed: Map<String, String>)

    /** A remote audio track is subscribed. [isMicrophoneSource] marks the agent's speech. */
    fun onAudioTrackSubscribed(isMicrophoneSource: Boolean)

    fun onData(topic: String?, payload: ByteArray)

    fun onTextStreamOpened(streamId: String, topic: String, fromLocalIdentity: Boolean, attributes: Map<String, String>)
    fun onTextStreamChunk(streamId: String, text: String)

    /** [aborted] is true when the stream ended abnormally; what arrived before still counts. */
    fun onTextStreamClosed(streamId: String, aborted: Boolean)
}

internal interface RoomAdapter {
    var listener: RoomListener?

    /** The room's state right now. Read when a fact is handled, not cached. */
    val state: RoomState
    val remoteParticipantCount: Int

    /** The attributes of every remote participant in the room. They are sticky: no change event fires for them. */
    fun remoteParticipantAttributes(): List<Map<String, String>>

    /**
     * Starts joining. On Android this returns while the room is still
     * [RoomState.CONNECTING]; [RoomListener.onConnected] follows.
     */
    suspend fun connect(url: String, token: String)

    /** Leaves the room and frees it. Safe to call more than once. */
    fun disconnect()

    /** Fire and forget. Dropped without an error when the room is not [RoomState.CONNECTED] yet. */
    fun setLocalAttributes(attributes: Map<String, String>)

    /** Sends one reliable data packet. Throws when it cannot be sent. */
    suspend fun publishData(payload: ByteArray, topic: String)

    /** Captures and publishes the microphone, or mutes it. Throws when it cannot. */
    suspend fun setMicrophoneEnabled(enabled: Boolean)
}
