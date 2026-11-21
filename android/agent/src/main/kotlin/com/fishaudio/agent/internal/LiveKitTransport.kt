package com.fishaudio.agent.internal

import android.util.Log
import com.fishaudio.agent.FishAgentError
import com.fishaudio.agent.FishAgentErrorCode
import com.fishaudio.agent.MessageRole
import com.fishaudio.agent.SessionToken
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonObject

/** How long `Room.connect` gets to reach CONNECTED after it returns. Measured: 300 to 500 ms. */
internal const val ROOM_CONNECTED_TIMEOUT_MS = 20_000L

/**
 * After a reconnect, how long the agent gets to reappear in the roster before
 * it counts as gone. `Reconnected` can arrive before the roster is rebuilt:
 * 41 ms was measured after a 40 s outage.
 */
internal const val ROSTER_GRACE_MS = 2_000L

private const val TAG = "FishAgent"

/**
 * The production transport: the rules of docs/protocol.md on top of a LiveKit
 * room. The logic follows packages/client/src/transport/livekit.ts, except
 * where LiveKit behaves differently on Android. Each such place is marked
 * "Android:" and comes from the recordings in
 * src/test/resources/livekit-recordings (see the README there).
 */
internal class LiveKitTransport(
    private val room: RoomAdapter,
    /** The main dispatcher's scope. Everything here runs on it. */
    private val scope: CoroutineScope,
    /** Current time in epoch ms, for the audio-ready stamp. */
    private val now: () -> Long,
) : Transport, RoomListener {
    private var callbacks: TransportCallbacks? = null

    /** Completed when the room first reports CONNECTED; fails if it disconnects before that. */
    private var connected: CompletableDeferred<Unit>? = null

    /** The epoch-ms value published as `fish.client.audio_ready`, kept to publish again after a reconnect. */
    private var audioReadyStamp: String? = null

    /** A DISCONNECTED was already reported to the session; nothing more is reported. */
    private var ended = false
    private var rosterGrace: Job? = null

    private class TextStream(val segmentId: String, val role: MessageRole, val finalAttribute: Boolean) {
        val text = StringBuilder()
    }

    private val streams = HashMap<String, TextStream>()

    // ---- Transport ----

    override suspend fun connect(sessionToken: SessionToken, options: TransportConnectOptions) {
        val url = sessionToken.livekitUrl
        val token = sessionToken.token
        if (url.isNullOrEmpty() || token.isNullOrEmpty()) {
            throw FishAgentError(FishAgentErrorCode.CONNECTION_FAILED, "The session token has no LiveKit URL or join token")
        }
        callbacks = options.callbacks
        room.listener = this
        val reached = CompletableDeferred<Unit>()
        connected = reached
        try {
            room.connect(url, token)
            // Android: connect() returns while the room is still CONNECTING, and
            // an attribute set before CONNECTED is dropped without an error.
            if (room.state != RoomState.CONNECTED) {
                withTimeout(ROOM_CONNECTED_TIMEOUT_MS) { reached.await() }
            }
        } catch (cancelled: TimeoutCancellationException) {
            throw FishAgentError(
                FishAgentErrorCode.CONNECTION_FAILED,
                "Could not establish the realtime session",
                cause = cancelled,
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: FishAgentError) {
            throw error
        } catch (error: Throwable) {
            throw FishAgentError(
                FishAgentErrorCode.CONNECTION_FAILED,
                "Could not establish the realtime session",
                cause = error,
            )
        } finally {
            connected = null
        }

        // Before anything else waits: the runtime holds its opening line only
        // for a client that announces "pending" shortly after its pipeline is
        // live. A ready stamp reported while connecting must not be overwritten.
        publishAudioReady(audioReadyStamp ?: Protocol.CLIENT_AUDIO_READY_PENDING)
        // The agent's attributes are sticky: an agent that joined before us
        // fires no change event, so read the current values once.
        replayAgentAttributes()
        if (options.microphone) {
            room.setMicrophoneEnabled(true)
        }
    }

    override suspend fun disconnect() {
        rosterGrace?.cancel()
        rosterGrace = null
        callbacks = null
        room.listener = null
        streams.clear()
        room.disconnect()
    }

    override suspend fun setMicEnabled(enabled: Boolean) {
        room.setMicrophoneEnabled(enabled)
    }

    override suspend fun sendClientEvent(message: JsonObject) {
        if (callbacks == null || room.state == RoomState.DISCONNECTED) {
            throw FishAgentError(FishAgentErrorCode.CONNECTION_FAILED, "Session is not connected")
        }
        room.publishData(JsonValues.encode(message).toByteArray(Charsets.UTF_8), Protocol.CLIENT_EVENT_TOPIC)
    }

    // ---- RoomListener ----

    override fun onConnected() {
        connected?.complete(Unit)
    }

    override fun onReconnecting() {
        rosterGrace?.cancel()
        rosterGrace = null
        report(TransportConnectionState.RECONNECTING)
    }

    override fun onReconnected() {
        // A full reconnect drops the local attributes on the server; set the same value again.
        publishAudioReady(audioReadyStamp ?: Protocol.CLIENT_AUDIO_READY_PENDING)
        report(TransportConnectionState.CONNECTED)
        if (room.remoteParticipantCount > 0) {
            replayAgentAttributes()
            return
        }
        // Android: the roster can still be empty here even though the agent is
        // in the room. Give it a moment before deciding the agent hung up
        // while we were away. Its attributes are read when it reappears.
        rosterGrace = scope.launch {
            delay(ROSTER_GRACE_MS)
            rosterGrace = null
            if (room.state == RoomState.CONNECTED && room.remoteParticipantCount == 0) {
                handleAgentLeft()
            }
        }
    }

    override fun onDisconnected(reason: String) {
        connected?.completeExceptionally(
            FishAgentError(FishAgentErrorCode.CONNECTION_FAILED, "The room disconnected while joining ($reason)"),
        )
        report(TransportConnectionState.DISCONNECTED, reason)
    }

    override fun onParticipantConnected(attributes: Map<String, String>) {
        rosterGrace?.cancel()
        rosterGrace = null
        // A participant that joins already carrying its sticky attributes fires no attribute change.
        handleAgentAttributes(attributes)
    }

    override fun onParticipantDisconnected() {
        // Android: this also fires while the room is RECONNECTING (the roster
        // is cleared) and while it is DISCONNECTED (during any teardown). The
        // agent has left only when the room is still CONNECTED. Wait one turn
        // of the main loop before reading the state, so a reconnect that
        // starts right behind this event is not mistaken for a hangup.
        if (room.remoteParticipantCount > 0) return
        scope.launch {
            yield()
            if (room.state == RoomState.CONNECTED && room.remoteParticipantCount == 0 && rosterGrace == null) {
                handleAgentLeft()
            }
        }
    }

    override fun onAttributesChanged(isLocal: Boolean, changed: Map<String, String>) {
        if (!isLocal) handleAgentAttributes(changed)
    }

    override fun onAudioTrackSubscribed(isMicrophoneSource: Boolean) {
        // Native WebRTC plays a subscribed track by itself, with no autoplay
        // gate. The agent's speech is its microphone-source track; any other
        // track (background ambience) says nothing about the voice.
        if (!isMicrophoneSource || audioReadyStamp != null) return
        val stamp = now().toString()
        audioReadyStamp = stamp
        publishAudioReady(stamp)
    }

    override fun onData(topic: String?, payload: ByteArray) {
        // Android: after a reconnect our own reliable packets come back on
        // `client-event`. Only the agent's topic is handled.
        if (topic != Protocol.AGENT_EVENT_TOPIC) return
        val message = JsonValues.parseObject(String(payload, Charsets.UTF_8))
        if (message?.string("type") == null) return
        callbacks?.onAgentEvent(message)
    }

    // Both sides' transcripts arrive on LiveKit text streams. Agent segments
    // are one stream of deltas that follows playback, final when the stream
    // closes (an interrupted reply closes holding only what was spoken). User
    // segments are sent again in full on every update, each with an explicit
    // final attribute, on behalf of the user: the sender's identity tells the role.
    override fun onTextStreamOpened(
        streamId: String,
        topic: String,
        fromLocalIdentity: Boolean,
        attributes: Map<String, String>,
    ) {
        if (topic != Protocol.TRANSCRIPTION_TOPIC) return
        val segmentId = attributes[Protocol.SEGMENT_ID_ATTRIBUTE]
        if (segmentId.isNullOrEmpty()) return
        streams[streamId] = TextStream(
            segmentId = segmentId,
            role = if (fromLocalIdentity) MessageRole.USER else MessageRole.AGENT,
            finalAttribute = attributes[Protocol.TRANSCRIPTION_FINAL_ATTRIBUTE] == "true",
        )
    }

    override fun onTextStreamChunk(streamId: String, text: String) {
        val stream = streams[streamId] ?: return
        stream.text.append(text)
        callbacks?.onTranscription(TranscriptionSegmentUpdate(stream.segmentId, stream.role, stream.text.toString(), false))
    }

    override fun onTextStreamClosed(streamId: String, aborted: Boolean) {
        val stream = streams.remove(streamId) ?: return
        if (stream.text.isEmpty()) return
        val isFinal = if (stream.role == MessageRole.AGENT) true else stream.finalAttribute && !aborted
        callbacks?.onTranscription(TranscriptionSegmentUpdate(stream.segmentId, stream.role, stream.text.toString(), isFinal))
    }

    // ---- internals ----

    private fun report(state: TransportConnectionState, reason: String? = null) {
        if (ended) return
        if (state == TransportConnectionState.DISCONNECTED) {
            ended = true
            rosterGrace?.cancel()
            rosterGrace = null
        }
        callbacks?.onConnectionState(state, reason)
    }

    private fun handleAgentLeft() {
        report(TransportConnectionState.DISCONNECTED, DisconnectReasons.AGENT_LEFT)
        room.disconnect()
    }

    private fun replayAgentAttributes() {
        for (attributes in room.remoteParticipantAttributes()) handleAgentAttributes(attributes)
    }

    private fun handleAgentAttributes(attributes: Map<String, String>) {
        if (!attributes[Protocol.AGENT_READY_ATTRIBUTE].isNullOrEmpty()) {
            callbacks?.onAgentReady()
        }
        attributes[Protocol.AGENT_STATE_ATTRIBUTE]?.takeIf { it.isNotEmpty() }?.let { callbacks?.onAgentState(it) }
    }

    /**
     * Best effort: the runtime's wait is bounded, so a lost report only costs
     * the handshake. The ready stamp also goes out as a data message, because
     * LiveKit holds attribute updates from a participant with no published
     * track (a call started with the microphone off) for seconds.
     */
    private fun publishAudioReady(value: String) {
        try {
            room.setLocalAttributes(mapOf(Protocol.CLIENT_AUDIO_READY_ATTRIBUTE to value))
        } catch (error: Throwable) {
            Log.d(TAG, "Setting the audio readiness attribute failed", error)
        }
        if (value == Protocol.CLIENT_AUDIO_READY_PENDING) return
        val message = ClientMessages.audioReady(value.toLong())
        scope.launch {
            try {
                room.publishData(JsonValues.encode(message).toByteArray(Charsets.UTF_8), Protocol.CLIENT_EVENT_TOPIC)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                Log.d(TAG, "Sending the audio readiness report failed", error)
            }
        }
    }
}
