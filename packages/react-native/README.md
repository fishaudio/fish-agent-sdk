# @fishaudio/agent-react-native

Voice calls with [Fish Audio](https://fish.audio) agents in React Native apps. It runs the same session code as the web SDK and adds what phones need: the microphone permission, the platform audio session, audio routing (speaker, earpiece, headsets), and background calls on Android.

## Requirements

- An Expo app with a [development build](https://docs.expo.dev/develop/development-builds/introduction/). WebRTC is a native module, so Expo Go cannot run it. Bare React Native works too, with `expo` installed for its modules.
- The iOS and Android versions your React Native version supports.

## Install

```sh
npx expo install @fishaudio/agent-react-native @livekit/react-native @livekit/react-native-webrtc \
  @livekit/react-native-expo-plugin @config-plugins/react-native-webrtc livekit-client
```

Add the config plugins to `app.json`, then rebuild (`npx expo prebuild`, `npx expo run:ios` / `run:android`):

```json
{
  "expo": {
    "plugins": [
      "@livekit/react-native-expo-plugin",
      "@config-plugins/react-native-webrtc",
      ["@fishaudio/agent-react-native", { "microphonePermission": "Talk to our assistant by voice." }]
    ]
  }
}
```

The plugin sets the iOS microphone text and the `audio` background mode. On Android, the package's own manifest adds the microphone and foreground-service permissions when the app is built.

## Use

Call `setupFishAgent()` first in your entry file, before anything else imports the SDK:

```ts
// index.ts
import { setupFishAgent } from "@fishaudio/agent-react-native";
setupFishAgent();

import { registerRootComponent } from "expo";
import App from "./App";
registerRootComponent(App);
```

```tsx
import { useAgentMessages, useConversation } from "@fishaudio/agent-react-native";

function Call() {
  const conversation = useConversation(
    { clientTools: { show_order: async ({ orderId }) => ({ shown: true }) } },
    { callNotification: { title: "Talking to support" } },
  );
  const messages = useAgentMessages(conversation.session);

  const start = async () => {
    // From your backend: POST /v1/agent/sessions with your API key.
    const sessionToken = await fetch("https://your.api/agent-session").then((r) => r.json());
    await conversation.startSession({ sessionToken });
  };
  // conversation.status, .mode, .micMuted, .endSession(), .setMicMuted(),
  // .sendUserMessage(), .interrupt(), .audioOutput, .setAudioOutput()
}
```

`useConversation` is the [`@fishaudio/agent-react` hook](../../docs/react/useConversation.md) with these additions:

| | |
|---|---|
| `startSession` | On Android, asks for the microphone first (fails with `mic_permission_denied` on a no). Starts the audio session and, on Android, the call's foreground service, then the session. |
| `endSession` | Also stops the audio session and the foreground service. They are released as well when the agent hangs up or the connection drops. |
| `audioOutput`, `setAudioOutput(route)` | `auto` (default): a connected Bluetooth or wired headset, else the loudspeaker. `speaker`: always the loudspeaker. `earpiece`: the receiver. Can be changed during a call. |

Second argument, `MobileConversationOptions`:

| Option | Default | |
|---|---|---|
| `audioOutput` | `"auto"` | Initial route. |
| `callNotification` | `{ title: "Call in progress" }` | Android: the ongoing notification during a call. `false` turns off the foreground service, and the microphone is then silenced while the app is in the background (Android 14+). |

## Session tokens

Create session tokens on your backend with your API key, and hand them to the app. Do not ship an API key in an app.

Public (keyless) agents are meant for browsers: the server checks the `Origin` header, which a native app does not send. See [Authentication](../../docs/authentication.md).

## Background calls

- **iOS:** the `audio` background mode keeps the call going when the app is in the background or the screen is locked.
- **Android:** a microphone foreground service runs during each call, with an ongoing notification. Without it, Android 14+ silences the microphone as soon as the app leaves the foreground, while the agent keeps talking. On Android 13+, users who deny notifications still get the service; the notification only shows in the task manager.
