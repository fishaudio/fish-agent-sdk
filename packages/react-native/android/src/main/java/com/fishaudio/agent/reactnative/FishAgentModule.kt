package com.fishaudio.agent.reactnative

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class FishAgentModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = NAME

  // Call while the app is in the foreground and after RECORD_AUDIO is granted:
  // Android refuses a microphone-type foreground service otherwise.
  // Resolves false when the permission is missing (nothing started).
  @ReactMethod
  fun startCallService(title: String, text: String, promise: Promise) {
    val context = reactApplicationContext
    // A microphone-type service without the permission throws inside the
    // service, after this call returned; refuse up front instead.
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      promise.resolve(false)
      return
    }
    try {
      val intent = Intent(context, FishCallService::class.java)
        .putExtra(FishCallService.EXTRA_TITLE, title)
        .putExtra(FishCallService.EXTRA_TEXT, text)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      serviceStarted = true
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("call_service_failed", error.message, error)
    }
  }

  // Sent as an intent rather than stopService: intents are delivered in order,
  // so the service has entered the foreground before it stops (stopping a
  // startForegroundService service earlier crashes the app).
  @ReactMethod
  fun stopCallService() {
    // Never started: sending the stop intent would only create the service.
    if (!serviceStarted) {
      return
    }
    serviceStarted = false
    val context = reactApplicationContext
    try {
      context.startService(Intent(context, FishCallService::class.java).setAction(FishCallService.ACTION_STOP))
    } catch (error: Exception) {
      // Not running and the app is in the background, where startService is
      // refused: nothing to stop beyond a plain stopService.
      try {
        context.stopService(Intent(context, FishCallService::class.java))
      } catch (_: Exception) {
      }
    }
  }

  companion object {
    const val NAME = "FishAgentReactNative"

    // Process-wide: the service outlives a JS reload, the module instance does not.
    @Volatile
    private var serviceStarted = false
  }
}
