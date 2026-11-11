# @fishaudio/agent-react-native

Voice calls with [Fish Audio](https://fish.audio) agents in React Native apps. It runs the same session code as the web SDK and adds what phones need: the microphone permission, the audio session and routing (loudspeaker, earpiece, headsets), and background calls on iOS and Android.

**Full documentation:** [React Native SDK](https://github.com/fishaudio/fish-agent-sdk-web/blob/main/docs/react-native.md), covering Expo and bare React Native setup, the entry file for expo-router, session tokens, the API, background calls, limitations and troubleshooting.

## Requirements

- Expo (built natively with `npx expo run:ios` / `run:android` or EAS Build; Expo Go cannot run WebRTC) or bare React Native.
- A backend that creates session tokens with your API key (recommended), or a public agent: `startSession({ agentId, origin })` with an origin on its allowlist (`origin` is experimental). Never ship the API key in the app.
- Tested with Expo SDK 58 and bare React Native 0.88, `@livekit/react-native` 3.1, `@livekit/react-native-webrtc` 150.1 and `livekit-client` 2.20–2.23, on iOS 26 and Android 17.

## Install

```sh
npx expo install @fishaudio/agent-react-native @livekit/react-native @livekit/react-native-webrtc \
  @livekit/react-native-expo-plugin @config-plugins/react-native-webrtc livekit-client
```

`npx expo install` adds the config plugins to `app.json`. To set the iOS microphone prompt text, give ours an option:

```json
["@fishaudio/agent-react-native", { "microphonePermission": "Talk to our assistant by voice." }]
```

Then build: `npx expo run:ios --device` or `npx expo run:android --device`.

Bare React Native: install the same packages without the two plugin packages, follow LiveKit's native setup, and add `NSMicrophoneUsageDescription` and the `audio` background mode to `Info.plist`. Details in the [full documentation](https://github.com/fishaudio/fish-agent-sdk-web/blob/main/docs/react-native.md#bare-react-native).

## Use

Call `setupFishAgent()` at the top of your entry file. With expo-router, create `index.ts` with the lines below and set `"main": "index.ts"` in `package.json`:

```ts
import { setupFishAgent } from "@fishaudio/agent-react-native";
setupFishAgent();

import "expo-router/entry"; // or your registerRootComponent(App) entry
```

```tsx
import { useAgentMessages, useConversation } from "@fishaudio/agent-react-native";

function SupportCall() {
  const conversation = useConversation({}, { callNotification: { title: "Talking to support" } });
  const messages = useAgentMessages(conversation.session);

  const start = async () => {
    const sessionToken = await fetch("https://api.example.com/agent-session", { method: "POST" })
      .then((r) => r.json());
    await conversation.startSession({ sessionToken });
  };
  // conversation.status, .mode, .endSession(), .setMicMuted(), .sendUserMessage(),
  // .interrupt(), .audioOutput, .setAudioOutput("auto" | "speaker" | "earpiece")
}
```

## Limitations

- No audio levels on React Native: `useAudioLevels` and `AgentAudioVisualizer` are not exported.
- `audioOutput` is the route you asked for, not the device currently playing; there is no route-change event.
- In Chinese conversations `mode` shows `speaking` only briefly, because the agent's text arrives in one piece.
- Not yet tested: incoming phone calls, Bluetooth headsets, network handover, reconnecting after a drop on iOS.
