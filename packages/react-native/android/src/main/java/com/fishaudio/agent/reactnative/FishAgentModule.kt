package com.fishaudio.agent.reactnative

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class FishAgentModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("FishAgentReactNative")

    // Call while the app is in the foreground and after RECORD_AUDIO is granted:
    // Android refuses a microphone-type foreground service otherwise.
    Function("startCallService") { title: String, text: String ->
      // A microphone-type service without the permission throws inside the
      // service, after this call returned; refuse up front instead.
      if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
        return@Function false
      }
      val intent = Intent(context, FishCallService::class.java)
        .putExtra(FishCallService.EXTRA_TITLE, title)
        .putExtra(FishCallService.EXTRA_TEXT, text)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
      true
    }

    Function("stopCallService") {
      context.stopService(Intent(context, FishCallService::class.java))
    }
  }
}
