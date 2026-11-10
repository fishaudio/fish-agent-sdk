import { registerGlobals } from "@livekit/react-native";

let registered = false;

/**
 * Installs the WebRTC globals the SDK runs on. Call it once, first thing in
 * your entry file, before any other import touches the SDK or LiveKit.
 */
export function setupFishAgent(): void {
  if (registered) {
    return;
  }
  registered = true;
  registerGlobals();
}
