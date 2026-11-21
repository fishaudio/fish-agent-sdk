package com.fishaudio.agent.internal

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.fishaudio.agent.CallNotification

/**
 * Keeps microphone capture alive while the app is in the background. Android
 * 14 and later silence an app's recording as soon as it leaves the foreground
 * unless a microphone-type foreground service is running; the call itself
 * would go on with the agent hearing nothing.
 *
 * The same service as the React Native SDK's, which was verified on devices.
 */
internal class FishCallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    /** startForeground has run (or was refused) for this service instance. */
    private var foregroundHandled = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Intents arrive in order, so a stop sent right after the start is
        // handled after the start has entered the foreground. Android crashes
        // the app when a service begun with startForegroundService stops
        // before startForeground.
        if (intent?.action == ACTION_STOP) {
            if (foregroundHandled) stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!foregroundHandled) {
            foregroundHandled = true
            enterForeground(intent)
        }
        return START_NOT_STICKY
    }

    private fun enterForeground(intent: Intent?) {
        val notification = buildNotification(
            title = intent?.getStringExtra(EXTRA_TITLE) ?: "Call in progress",
            text = intent?.getStringExtra(EXTRA_TEXT).orEmpty(),
        )
        try {
            // The microphone type exists from Android 11 (API 30). Before that a
            // plain foreground service is enough to keep capturing.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (error: Exception) {
            // Refused (started from the background, for one): the call goes on,
            // only without background capture. Never take the app down for it.
            Log.w(TAG, "The call service could not enter the foreground", error)
            stopSelf()
        }
    }

    /** Swiping the app away ends the call; the service must not outlive it. */
    override fun onTaskRemoved(rootIntent: Intent?) {
        stopSelf()
    }

    private fun buildNotification(title: String, text: String): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Voice calls", NotificationManager.IMPORTANCE_LOW),
                )
            }
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        builder
            .setContentTitle(title)
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setCategory(Notification.CATEGORY_CALL)
        if (text.isNotEmpty()) builder.setContentText(text)
        packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
            builder.setContentIntent(PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE))
        }
        return builder.build()
    }

    companion object {
        private const val TAG = "FishAgent"
        private const val ACTION_STOP = "com.fishaudio.agent.STOP_CALL_SERVICE"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_TEXT = "text"
        private const val CHANNEL_ID = "fish_agent_call"
        private const val NOTIFICATION_ID = 0x46495348 // "FISH"

        // Process-wide: the service is one per app, whichever Conversation started it.
        @Volatile
        private var started = false

        /**
         * Starts the service. Call while the app is in the foreground and
         * after `RECORD_AUDIO` is granted: Android refuses a microphone-type
         * foreground service otherwise. Returns false when nothing was started.
         */
        fun start(context: Context, notification: CallNotification): Boolean {
            // A microphone-type service without the permission throws inside
            // the service, after this call returned; refuse up front instead.
            if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                return false
            }
            return try {
                val intent = Intent(context, FishCallService::class.java)
                    .putExtra(EXTRA_TITLE, notification.title)
                    .putExtra(EXTRA_TEXT, notification.text)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
                started = true
                true
            } catch (error: Exception) {
                Log.w(TAG, "The call service could not be started", error)
                false
            }
        }

        /**
         * Stops the service through an intent, not `stopService`: intents are
         * delivered in order, so the service has entered the foreground before
         * it stops.
         */
        fun stop(context: Context) {
            // Never started: sending the stop intent would only create the service.
            if (!started) return
            started = false
            try {
                context.startService(Intent(context, FishCallService::class.java).setAction(ACTION_STOP))
            } catch (_: Exception) {
                // Not running and the app is in the background, where
                // startService is refused: a plain stopService is all that is left.
                try {
                    context.stopService(Intent(context, FishCallService::class.java))
                } catch (_: Exception) {
                }
            }
        }
    }
}
