package com.fishaudio.agent

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import java.util.UUID
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/**
 * The microphone permission. [Conversation.startSession] does not ask for it:
 * a permission dialog has to come from an Activity, and the SDK does not own
 * one. Ask before starting a call:
 *
 * ```
 * if (FishAgentPermissions.requestMicrophonePermission(activity)) {
 *     conversation.startSession(SessionAuth.Token(token))
 * }
 * ```
 *
 * Without the permission, a call that needs the microphone fails with
 * [FishAgentErrorCode.MIC_PERMISSION_DENIED].
 */
public object FishAgentPermissions {
    /** Whether the app holds `RECORD_AUDIO`. */
    @JvmStatic
    public fun hasMicrophonePermission(context: Context): Boolean =
        context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /**
     * Shows the system's microphone permission dialog if the permission is not
     * granted yet, and returns whether the app holds it afterwards.
     *
     * Can be called at any time while [activity] is started, for example from a
     * click handler: it does not need to be registered in `onCreate`. When the
     * user has refused before and chosen not to be asked again, the system
     * shows nothing and this returns false.
     */
    public suspend fun requestMicrophonePermission(activity: ComponentActivity): Boolean {
        if (hasMicrophonePermission(activity)) return true
        return withContext(Dispatchers.Main.immediate) {
            suspendCancellableCoroutine { continuation ->
                var launcher: ActivityResultLauncher<String>? = null
                launcher = activity.activityResultRegistry.register(
                    "fish-agent-microphone-${UUID.randomUUID()}",
                    ActivityResultContracts.RequestPermission(),
                ) { granted ->
                    launcher?.unregister()
                    if (continuation.isActive) continuation.resume(granted)
                }
                continuation.invokeOnCancellation { launcher.unregister() }
                launcher.launch(Manifest.permission.RECORD_AUDIO)
            }
        }
    }
}
