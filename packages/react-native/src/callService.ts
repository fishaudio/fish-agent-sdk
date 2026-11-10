import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";

interface FishAgentNativeModule {
  /** False when RECORD_AUDIO is not granted (nothing started). */
  startCallService(title: string, text: string): boolean;
  stopCallService(): void;
}

export interface CallNotification {
  /** Notification title while a call runs in the background. Default "Call in progress". */
  title?: string;
  text?: string;
}

let native: FishAgentNativeModule | null | undefined;

function nativeModule(): FishAgentNativeModule | null {
  if (native === undefined) {
    native =
      Platform.OS === "android"
        ? requireOptionalNativeModule<FishAgentNativeModule>("FishAgentReactNative")
        : null;
  }
  return native;
}

let warned = false;

/**
 * Android only: a microphone foreground service with an ongoing notification,
 * without which Android 14+ silences capture once the app is backgrounded.
 * No-op elsewhere, and a warning (not a failure) when the native module is
 * missing, e.g. in Expo Go or before a rebuild.
 */
export function startCallService(notification: CallNotification = {}): void {
  const module = nativeModule();
  if (!module) {
    if (Platform.OS === "android" && !warned) {
      warned = true;
      console.warn(
        "[fish-agent] Native module missing: background calls will lose the microphone. " +
          "Rebuild the app (expo prebuild / run:android) after installing the package.",
      );
    }
    return;
  }
  try {
    module.startCallService(notification.title ?? "Call in progress", notification.text ?? "");
  } catch (error) {
    console.warn("[fish-agent] Could not start the call service", error);
  }
}

export function stopCallService(): void {
  try {
    nativeModule()?.stopCallService();
  } catch {
    // Already stopped.
  }
}
