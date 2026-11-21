package com.fishaudio.agent.internal

import android.content.Context
import com.fishaudio.agent.AudioOutputRoute
import com.fishaudio.agent.CallNotification
import com.fishaudio.agent.FishAgentPermissions
import com.fishaudio.agent.FishAgentSdk
import java.util.TimeZone
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/** A transport for one call and the handle that routes its audio. */
internal class CallTransport(val transport: Transport, val router: AudioRouter)

/**
 * Everything `Conversation` needs from the device. Tests replace it; the app
 * gets [AndroidEnvironment].
 */
internal interface ConversationEnvironment {
    /** The conversation's own scope: single-threaded (the main dispatcher), with a supervisor job. */
    val scope: CoroutineScope
    val tokens: SessionTokenResolver
    fun hasMicrophonePermission(): Boolean

    /** A fresh transport for one call, with its audio already routed to [route]. */
    fun createTransport(route: AudioOutputRoute): CallTransport

    /** Returns false when the service could not be started; the call goes on without it. */
    fun startCallService(notification: CallNotification): Boolean
    fun stopCallService()
}

internal class AndroidEnvironment(context: Context) : ConversationEnvironment {
    private val context = context.applicationContext

    override val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override val tokens = SessionTokenResolver(
        http = UrlConnectionHttpClient(),
        now = System::currentTimeMillis,
        clientTimezone = { TimeZone.getDefault().id },
        sdkHeader = "agent-android/${FishAgentSdk.VERSION}",
    )

    override fun hasMicrophonePermission(): Boolean = FishAgentPermissions.hasMicrophonePermission(context)

    override fun createTransport(route: AudioOutputRoute): CallTransport {
        val room = LiveKitRoomAdapter(context, scope)
        room.route(route)
        return CallTransport(LiveKitTransport(room, scope, System::currentTimeMillis), room)
    }

    override fun startCallService(notification: CallNotification): Boolean = FishCallService.start(context, notification)

    override fun stopCallService() = FishCallService.stop(context)
}

/**
 * One call per process. The call service and the audio session are
 * process-wide: two calls at once would stop each other's service and reset
 * each other's audio.
 */
internal object CallSlot {
    private val owner = AtomicReference<Any?>(null)

    /** True when [candidate] holds the slot afterwards (it was free, or already theirs). */
    fun claim(candidate: Any): Boolean = owner.compareAndSet(null, candidate) || owner.get() === candidate

    fun release(candidate: Any) {
        owner.compareAndSet(candidate, null)
    }

    /** For tests: the slot is process-wide and would otherwise leak from one test into the next. */
    internal fun clearForTests() = owner.set(null)
}
