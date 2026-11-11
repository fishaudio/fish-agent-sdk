import { NativeModules, Platform } from "react-native";

interface FishAgentNativeModule {
  /** Resolves false when RECORD_AUDIO is not granted (nothing started). */
  startCallService(title: string, text: string): Promise<boolean>;
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
        ? ((NativeModules.FishAgentReactNative as FishAgentNativeModule | undefined) ?? null)
        : null;
  }
  return native;
}

let warned = false;

/**
 * Android only: a microphone foreground service with an ongoing notification,
 * without which Android 14+ silences capture once the app is backgrounded.
 * No-op elsewhere, and a warning (not a failure) when the native module is
 * missing, e.g. in Expo Go or before the app was rebuilt.
 */
export function startCallService(notification: CallNotification = {}): void {
  const module = nativeModule();
  if (!module) {
    if (Platform.OS === "android" && !warned) {
      warned = true;
      console.warn(
        "[fish-agent] Native module missing: background calls will lose the microphone. " +
          "Rebuild the native app (npx expo run:android, or npx react-native run-android) after installing the package.",
      );
    }
    return;
  }
  const warn = (error: unknown) => console.warn("[fish-agent] Could not start the call service", error);
  try {
    // Not awaited: the call does not wait on the notification.
    void Promise.resolve(
      module.startCallService(notification.title ?? "Call in progress", notification.text ?? ""),
    ).catch(warn);
  } catch (error) {
    warn(error);
  }
}

export function stopCallService(): void {
  try {
    nativeModule()?.stopCallService();
  } catch {
    // Already stopped.
  }
}
