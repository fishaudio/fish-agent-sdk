package com.fishaudio.agent.internal

import android.content.Context
import com.fishaudio.agent.FishAgentError
import com.fishaudio.agent.FishAgentErrorCode
import io.livekit.android.AudioOptions
import io.livekit.android.AudioType
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.LocalParticipant
import io.livekit.android.room.track.DataPublishReliability
import io.livekit.android.room.track.Track
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.plus

/**
 * The real room: `io.livekit:livekit-android` behind [RoomAdapter]. It holds
 * no logic of its own, only translation, because nothing here runs in unit
 * tests. LiveKit types must not leave this file.
 *
 * One adapter serves one call and is not reused after [disconnect].
 */
internal class LiveKitRoomAdapter(
    context: Context,
    /** The main dispatcher's scope. Facts are delivered on it. */
    scope: CoroutineScope,
) : RoomAdapter {
    private val work: CoroutineScope = scope + SupervisorJob(scope.coroutineContext.job)

    private val room: Room = LiveKit.create(
        appContext = context.applicationContext,
        // A voice call: communication audio mode, voice-call stream, speech attributes.
        overrides = LiveKitOverrides(audioOptions = AudioOptions(audioOutputType = AudioType.CallAudioType())),
    )

    private var released = false

    override var listener: RoomListener? = null

    override val state: RoomState
        get() = when (room.state) {
            Room.State.CONNECTING -> RoomState.CONNECTING
            Room.State.CONNECTED -> RoomState.CONNECTED
            Room.State.RECONNECTING -> RoomState.RECONNECTING
            Room.State.DISCONNECTED -> RoomState.DISCONNECTED
        }

    override val remoteParticipantCount: Int get() = room.remoteParticipants.size

    override fun remoteParticipantAttributes(): List<Map<String, String>> =
        room.remoteParticipants.values.map { it.attributes }

    init {
        // Room events are collected on the main dispatcher. Text stream
        // handlers are called on a background thread, so each stream is moved
        // to the main dispatcher too: one queue, one order.
        work.launch { room.events.collect(::deliver) }
        room.registerTextStreamHandler(Protocol.TRANSCRIPTION_TOPIC) { reader, fromIdentity ->
            val streamId = reader.info.id
            val fromLocal = fromIdentity == room.localParticipant.identity
            val attributes = reader.info.attributes
            work.launch {
                listener?.onTextStreamOpened(streamId, reader.info.topic, fromLocal, attributes)
                val aborted = try {
                    reader.flow.collect { chunk -> listener?.onTextStreamChunk(streamId, chunk) }
                    false
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    // Ended abnormally; what arrived is what was spoken.
                    true
                }
                listener?.onTextStreamClosed(streamId, aborted)
            }
        }
    }

    private fun deliver(event: RoomEvent) {
        val listener = listener ?: return
        when (event) {
            is RoomEvent.Connected -> listener.onConnected()
            is RoomEvent.Reconnecting -> listener.onReconnecting()
            is RoomEvent.Reconnected -> listener.onReconnected()
            is RoomEvent.Disconnected -> listener.onDisconnected(event.reason.name)
            is RoomEvent.ParticipantConnected -> listener.onParticipantConnected(event.participant.attributes)
            is RoomEvent.ParticipantDisconnected -> listener.onParticipantDisconnected()
            is RoomEvent.ParticipantAttributesChanged ->
                listener.onAttributesChanged(event.participant is LocalParticipant, event.changedAttributes)
            is RoomEvent.TrackSubscribed ->
                if (event.track.kind == Track.Kind.AUDIO) {
                    listener.onAudioTrackSubscribed(event.publication.source == Track.Source.MICROPHONE)
                }
            is RoomEvent.DataReceived -> listener.onData(event.topic, event.data)
            else -> Unit
        }
    }

    override suspend fun connect(url: String, token: String) {
        room.connect(url, token)
    }

    override fun disconnect() {
        if (released) return
        released = true
        // release() disconnects and frees the room's native resources.
        room.release()
        work.cancel()
    }

    override fun setLocalAttributes(attributes: Map<String, String>) {
        room.localParticipant.updateAttributes(attributes)
    }

    override suspend fun publishData(payload: ByteArray, topic: String) {
        room.localParticipant.publishData(payload, DataPublishReliability.RELIABLE, topic).getOrThrow()
    }

    override suspend fun setMicrophoneEnabled(enabled: Boolean) {
        val applied = try {
            room.localParticipant.setMicrophoneEnabled(enabled)
        } catch (denied: SecurityException) {
            throw FishAgentError(
                FishAgentErrorCode.MIC_PERMISSION_DENIED,
                "The microphone permission is not granted",
                cause = denied,
            )
        }
        if (enabled && !applied) {
            throw FishAgentError(FishAgentErrorCode.CONNECTION_FAILED, "The microphone could not be published")
        }
    }
}
