import { AudioSession } from "@livekit/react-native";
import { Platform } from "react-native";

/**
 * Where the agent's voice plays.
 * - `auto` (default): the system's choice. A connected Bluetooth or wired
 *   headset wins; otherwise the loudspeaker.
 * - `speaker`: the loudspeaker, even with a headset connected.
 * - `earpiece`: the phone's receiver, held to the ear.
 */
export type AudioOutputRoute = "auto" | "speaker" | "earpiece";

const ANDROID_AUTO_ORDER = ["bluetooth", "headset", "speaker", "earpiece"];
const IOS_ROUTE_OPTIONS = ["allowBluetooth", "allowBluetoothA2DP", "allowAirPlay"] as const;

/**
 * Starts the platform audio session for a call. Call before connecting.
 *
 * iOS: WebRTC activates and deactivates the shared AVAudioSession itself as
 * capture starts and stops, keeping its own count. Toggling it from here as
 * well (LiveKit's start/stopAudioSession) leaves the second call of an app
 * run with a dead microphone, so on iOS only the category and route are set.
 */
export async function startCallAudio(route: AudioOutputRoute): Promise<void> {
  if (Platform.OS !== "ios") {
    await AudioSession.startAudioSession();
  }
  await applyAudioOutput(route, { initial: true });
}

/**
 * Releases the call's audio session. iOS: WebRTC deactivates the session when
 * capture stops but leaves the call category (playAndRecord, voice/video chat
 * mode) behind, which would make other audio in the app quieter and ignore the
 * silent switch. Only the category goes back to the system default here; the
 * activation stays WebRTC's (see startCallAudio).
 */
export async function stopCallAudio(): Promise<void> {
  if (Platform.OS === "ios") {
    await AudioSession.setAppleAudioConfiguration({
      audioCategory: "soloAmbient",
      audioCategoryOptions: [],
      audioMode: "default",
    });
    return;
  }
  await AudioSession.stopAudioSession();
}

/**
 * Routes call audio. `initial` marks the call's first routing: on Android,
 * `auto` then leaves LiveKit's own automatic selection in place, which also
 * follows headsets plugged in later.
 */
export async function applyAudioOutput(
  route: AudioOutputRoute,
  { initial = false }: { initial?: boolean } = {},
): Promise<void> {
  if (Platform.OS === "ios") {
    // Without defaultToSpeaker the receiver is the default route; with it the
    // loudspeaker is, and headsets still take over.
    const earpiece = route === "earpiece";
    await AudioSession.setAppleAudioConfiguration({
      audioCategory: "playAndRecord",
      audioCategoryOptions: earpiece ? [...IOS_ROUTE_OPTIONS] : [...IOS_ROUTE_OPTIONS, "defaultToSpeaker"],
      audioMode: earpiece ? "voiceChat" : "videoChat",
    });
    await AudioSession.selectAudioOutput(route === "speaker" ? "force_speaker" : "default");
    return;
  }
  if (Platform.OS === "android") {
    if (route !== "auto") {
      await AudioSession.selectAudioOutput(route);
      return;
    }
    if (initial) {
      return;
    }
    // Back from a manual pick: choose what automatic selection would.
    const outputs = await AudioSession.getAudioOutputs();
    const best = ANDROID_AUTO_ORDER.find((kind) => outputs.includes(kind));
    if (best) {
      await AudioSession.selectAudioOutput(best);
    }
  }
}
