package com.fishaudio.agent.reactnative

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Keeps microphone capture alive while the app is in the background. Android 14+
 * silences an app's recording as soon as it leaves the foreground unless a
 * microphone-type foreground service is running; the call itself would go on
 * with the agent hearing nothing.
 */
class FishCallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  /** startForeground has run (or was refused) for this service instance. */
  private var foregroundHandled = false

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Intents arrive in order, so a stop sent right after the start is handled
    // after the start has entered the foreground. (Android crashes the app when
    // a service begun with startForegroundService stops before startForeground.)
    if (intent?.action == ACTION_STOP) {
      if (foregroundHandled) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
          stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
          @Suppress("DEPRECATION")
          stopForeground(true)
        }
      }
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
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Call in progress"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    val notification = buildNotification(title, text)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (error: Exception) {
      // Refused (e.g. started from the background): the call goes on, only
      // without background capture. Never take the app down for it.
      stopSelf()
    }
  }

  // Swiping the app away ends the call; the service must not outlive it.
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
    if (text.isNotEmpty()) {
      builder.setContentText(text)
    }
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      builder.setContentIntent(
        PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE),
      )
    }
    return builder.build()
  }

  companion object {
    const val ACTION_STOP = "com.fishaudio.agent.reactnative.STOP"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL_ID = "fish_agent_call"
    private const val NOTIFICATION_ID = 0x46495348 // "FISH"
  }
}
