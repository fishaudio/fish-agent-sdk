package com.fishaudio.agent

/** Where the agent's voice plays. */
public enum class AudioOutputRoute {
    /** A connected Bluetooth or wired headset wins; otherwise the loudspeaker. */
    AUTO,

    /** The loudspeaker, even with a headset connected. */
    SPEAKER,

    /** The phone's receiver, held to the ear. */
    EARPIECE,
}

/** The notification shown while a call keeps the microphone running in the background. */
public data class CallNotification(
    val title: String = "Call in progress",
    val text: String = "",
)

/** What a phone needs around a call, on top of [SessionOptions]. */
public data class MobileOptions(
    /** Where the agent's voice plays when a call starts. Change it during a call with [Conversation.setAudioOutput]. */
    val audioOutput: AudioOutputRoute = AudioOutputRoute.AUTO,
    /**
     * During a call with the microphone on, the SDK runs a foreground service
     * with this notification: Android 14 and later silence an app's microphone
     * once it leaves the foreground otherwise. `null` runs no service; the
     * agent then hears nothing while the app is in the background.
     *
     * The notification is only visible when the app holds `POST_NOTIFICATIONS`
     * (Android 13 and later). The service works either way.
     */
    val callNotification: CallNotification? = CallNotification(),
)

/** One entry of a chat log. Streaming entries are refined in place under the same [key]. */
public data class ChatMessage(
    /** Stable for one segment. Use it as the list key. */
    val key: String,
    val role: MessageRole,
    val text: String,
    /** False while the segment is still streaming. */
    val isFinal: Boolean,
)

/**
 * A call to [Conversation.startSession] ended without a call because
 * [Conversation.endSession] or [Conversation.close] ran while it was starting.
 * Nothing is wrong and there is nothing to show the user.
 */
public class ConversationStartCancelledException :
    IllegalStateException("The conversation start was cancelled by endSession")
