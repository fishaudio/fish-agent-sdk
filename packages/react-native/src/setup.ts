import { registerGlobals } from "@livekit/react-native";

let registered = false;

/**
 * Installs the WebRTC globals the SDK runs on. Call it once, first thing in
 * your entry file. `startSession` also calls it when the globals are missing,
 * so forgetting it does not break calls, but the entry file is the safe place:
 * other code may touch WebRTC before the first call.
 */
export function setupFishAgent(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerGlobals();
}

/** True once WebRTC is available, through setupFishAgent or LiveKit's registerGlobals. */
export function hasWebRTCGlobals(): boolean {
  return typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection !== "undefined";
}
