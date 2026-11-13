import { PermissionsAndroid, Platform } from "react-native";
import { FishAgentError } from "@fishaudio/agent-client";

/**
 * Asks for the microphone on Android. iOS prompts on first capture by itself
 * (using NSMicrophoneUsageDescription), so this resolves there right away.
 * Rejects with `mic_permission_denied` when the user says no.
 */
export async function requestMicrophonePermission(): Promise<void> {
  if (Platform.OS !== "android") {
    return;
  }
  const permission = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  if (await PermissionsAndroid.check(permission)) {
    return;
  }
  const result = await PermissionsAndroid.request(permission);
  if (result !== PermissionsAndroid.RESULTS.GRANTED) {
    throw new FishAgentError("mic_permission_denied", "Microphone permission was denied");
  }
}
