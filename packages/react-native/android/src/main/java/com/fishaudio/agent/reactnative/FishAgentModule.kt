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
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("call_service_failed", error.message, error)
    }
  }

  @ReactMethod
  fun stopCallService() {
    reactApplicationContext.stopService(Intent(reactApplicationContext, FishCallService::class.java))
  }

  companion object {
    const val NAME = "FishAgentReactNative"
  }
}
