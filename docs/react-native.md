# React Native SDK

`@fishaudio/agent-react-native` adds voice calls with a Fish Audio agent to a React Native app. The call itself runs on the same code as the [Web SDK](README.md), so connection handling, transcripts, client tools and end reasons behave the same. On top of that the package handles what phones need:

- the microphone permission on Android,
- the platform audio session and routing (loudspeaker, earpiece, headsets),
- background calls: an Android foreground service and iOS background audio,
- an Expo config plugin for the native settings.

It works in Expo apps and in bare React Native apps; Expo is not required.

## Requirements

- **A native build.** WebRTC is a native module. In Expo, build with `npx expo run:ios` / `run:android` or EAS Build; Expo Go cannot run it (`expo-dev-client` is optional). Bare React Native apps build as usual, see [Bare React Native](#bare-react-native).
- **A physical device** for anything involving the microphone.
- **Your own backend** to create session tokens (see [Session tokens](#session-tokens)). Do not ship an API key inside an app.
- **Tested with** Expo SDK 58 and bare React Native 0.88, `@livekit/react-native` 3.1, `@livekit/react-native-webrtc` 150.1 and `livekit-client` 2.20–2.23, on iOS 26 and Android 17. Other versions may work but are untested.

## Install (Expo)

```sh
npx expo install @fishaudio/agent-react-native @livekit/react-native @livekit/react-native-webrtc \
  @livekit/react-native-expo-plugin @config-plugins/react-native-webrtc livekit-client
```

`npx expo install` adds the three config plugins to `app.json` for you. If you installed with npm or yarn instead, add them yourself:

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

Then build the native app: `npx expo run:ios --device` or `npx expo run:android --device`. Rebuild whenever you add a package with native code or change a plugin; a JavaScript reload does not pick those up.

Plugin options:

| Option | Default | |
|---|---|---|
| `microphonePermission` | `"Allow $(PRODUCT_NAME) to use the microphone for voice calls."` | iOS microphone prompt text. `false` leaves `NSMicrophoneUsageDescription` alone. |
| `backgroundAudio` | `true` | Adds the iOS `audio` background mode, so calls continue in the background and with the screen locked. |

On Android nothing needs configuring: the package's manifest adds the microphone, audio and foreground-service permissions and the service itself when the app is built.

## Bare React Native

Without Expo, install the packages without the config plugins and set the native options yourself:

```sh
npm install @fishaudio/agent-react-native @livekit/react-native @livekit/react-native-webrtc livekit-client
```

- **LiveKit setup:** follow the [LiveKit React Native installation](https://github.com/livekit/client-sdk-react-native#installation) for its native setup. That replaces the two LiveKit/WebRTC config plugins. In short:
  - Android `MainApplication.kt`: `LiveKitReactNative.setup(this, AudioType.CommunicationAudioType())` in `onCreate`.
  - iOS `AppDelegate.swift`: `import livekit_react_native`, then `LivekitReactNative.setup()` in `didFinishLaunchingWithOptions`.
  - iOS `Podfile`: LiveKit's WebRTC pod comes from LiveKit's own spec repo, so add both sources at the top, then run `cd ios && pod install --repo-update`. Without them `pod install` fails with `None of your spec sources contain a spec satisfying the dependency: LiveKitWebRTC`.

    ```ruby
    source 'https://github.com/livekit/podspecs.git'
    source 'https://cdn.cocoapods.org/'
    ```

- **iOS `Info.plist`:** add the microphone text, and the `audio` background mode so calls continue in the background:

  ```xml
  <key>NSMicrophoneUsageDescription</key>
  <string>Talk to our assistant by voice.</string>
  <key>UIBackgroundModes</key>
  <array>
    <string>audio</string>
  </array>
  ```

- **Android:** nothing to add. Autolinking registers the package's module, and its manifest brings the permissions and the foreground service.

Then build with `npx react-native run-ios` / `run-android`. The entry file is the same as [without expo-router](#set-up-the-entry-file), with `AppRegistry.registerComponent` in place of `registerRootComponent`.

## Set up the entry file

`setupFishAgent()` installs the WebRTC globals the SDK runs on. Call it once at the top of your entry file. `startSession` also installs them if they are missing, so a forgotten call does not break calls, but the entry file is the safe place: other code may touch WebRTC before the first call.

**With expo-router** (the default `create-expo-app` template), add an `index.ts`:

```ts
// index.ts
import { setupFishAgent } from "@fishaudio/agent-react-native";
setupFishAgent();

import "expo-router/entry";
```

and point `main` in `package.json` at it: `"main": "index.ts"`.

**Without expo-router**, call it at the top of your existing entry file:

```ts
// index.ts
import { setupFishAgent } from "@fishaudio/agent-react-native";
setupFishAgent();

import { registerRootComponent } from "expo";
import App from "./App";
registerRootComponent(App);
```

## Session tokens

The app asks your backend for a session token when the user starts a call. The backend calls `POST /v1/agent/sessions` with your API key and returns the response as is. [Authenticated sessions](authentication.md) has backend examples in Node and Python. The same endpoint serves web and mobile.

On a phone, two things differ from the browser:

- **`localhost` is the phone, not your computer.** During development, use your computer's LAN address, or on Android forward the port with `adb reverse tcp:3001 tcp:3001`.
- **iOS blocks plain `http://`** outside development builds. Serve the token endpoint over HTTPS.

Public agents (keyless sessions) are meant for websites: the server checks the browser's `Origin` header against an allowlist, and native apps do not send one. Use your own backend for apps.

## Quick start

```tsx
import { useAgentMessages, useConversation } from "@fishaudio/agent-react-native";
import { Button, FlatList, Text, View } from "react-native";

export default function SupportCall() {
  const conversation = useConversation(
    { clientTools: { show_order: async ({ orderId }) => ({ shown: true }) } },
    { callNotification: { title: "Talking to support" } },
  );
  const messages = useAgentMessages(conversation.session);

  const start = async () => {
    const sessionToken = await fetch("https://api.example.com/agent-session", { method: "POST" })
      .then((r) => r.json());
    await conversation.startSession({ sessionToken });
  };

  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text>{conversation.status} · {conversation.mode}</Text>
      <Button title="Call" onPress={() => void start()} />
      <Button title="Hang up" onPress={() => void conversation.endSession()} />
      <FlatList
        data={messages}
        keyExtractor={(m) => m.key}
        renderItem={({ item }) => <Text>{item.role}: {item.text}</Text>}
      />
    </View>
  );
}
```

`startSession` asks for the microphone on Android the first time (iOS asks on its own when capture starts), so call it from a button press.

## `useConversation(defaults?, options?)`

The [React SDK hook](react/useConversation.md) with the same arguments, return values and lifecycle, plus:

| Added | Type | Description |
|---|---|---|
| `startSession` | `(overrides?) => Promise<string>` | Also requests the Android microphone permission (rejects with `mic_permission_denied` on a no), sets up the audio session and route, and on Android starts the call's foreground service, before connecting. |
| `endSession` | `() => Promise<void>` | Also releases the audio session and stops the foreground service. Both are released as well when the agent hangs up or the connection drops. |
| `audioOutput` | `"auto" \| "speaker" \| "earpiece"` | The route you asked for (not the device currently playing, see [Limitations](#limitations)). |
| `setAudioOutput` | `(route) => Promise<void>` | Change the route, before or during a call. |

Routes:

- `auto` (default): a connected Bluetooth or wired headset, otherwise the loudspeaker.
- `speaker`: always the loudspeaker, even with a headset connected.
- `earpiece`: the phone's receiver, for holding it to the ear.

The second argument, `MobileConversationOptions`:

| Option | Default | |
|---|---|---|
| `audioOutput` | `"auto"` | Initial route. |
| `callNotification` | `{ title: "Call in progress" }` | Android: the ongoing notification shown during a call. `{ title, text }`. `false` turns off the foreground service, and the microphone is then silenced while the app is in the background. |

Everything else (`status`, `mode`, `micMuted` / `setMicMuted`, `sendUserMessage`, `interrupt`, `session`, client tools, callbacks, errors) is described in the [React SDK](react/useConversation.md), [Events](events.md), [Client tools](client-tools.md) and [Errors](errors.md) pages. `useAgentMessages` and `AgentSessionProvider` are re-exported from the React SDK and work the same way.

## Background calls

- **iOS:** with the `audio` background mode (on by default in the plugin), a call continues when the app goes to the background or the screen locks: the user can keep talking and hear the agent.
- **Android:** during a call the SDK runs a microphone foreground service with an ongoing notification. Android 14 and later silence an app's microphone as soon as it leaves the foreground unless such a service runs, while the agent keeps talking. On Android 13 and later, users who denied notifications still get the service; the notification is only hidden.

## Limitations

- **No audio levels.** React Native has no Web Audio API, so `useAudioLevels` and `session.getInputVolume()` / `getOutputVolume()` stay at 0, and `AgentAudioVisualizer` is not exported. Use `mode` to animate a speaking indicator.
- **`audioOutput` is the requested route,** not a report of the current device. Plugging in a headset in `auto` mode moves audio to it, but `audioOutput` still reads `auto`, and there is no route-change event.
- **`mode` and Chinese replies.** `speaking` follows the agent's transcript, which for Chinese replies currently arrives in one piece instead of following playback. In Chinese conversations `speaking` shows only briefly.
- **Not yet tested:** incoming phone calls interrupting a call, Bluetooth headsets, Wi-Fi/cellular handover, and reconnecting after a network drop on iOS.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Errors about a missing native module when running in Expo Go | Expo Go cannot load WebRTC. Build the app with `npx expo run:ios` / `run:android`. |
| Warning `Native module missing: background calls will lose the microphone` | The app was not rebuilt after installing the package. Rebuild the native app (`npx expo run:android` or `npx react-native run-android`). |
| `startSession` rejects with `connection_failed` ("Could not establish the realtime session") | Check that the token endpoint returned a token from `POST /v1/agent/sessions`, that it was used right away (tokens are short-lived), and that the device has network. If you call LiveKit or WebRTC APIs directly before the first call, call `setupFishAgent()` in the entry file first. |
| A plugin change has no effect (missing microphone text, no background audio) | Native settings only change on a rebuild: run `npx expo prebuild` (or `run:ios` / `run:android`) again. In bare React Native, check `Info.plist` and rebuild. |
| iOS `pod install` cannot find `LiveKitWebRTC` | The LiveKit pod sources are missing from the top of the `Podfile`, see [Bare React Native](#bare-react-native). |
| `fetch` to your token endpoint fails on the phone | `localhost` points at the phone. Use your computer's LAN address or `adb reverse`, and HTTPS on iOS. |
| Android: the agent stops hearing the user when the app is in the background | `callNotification` is `false`, or the app was not rebuilt after installing the package, so the foreground service is missing. |
| A permission prompt about local networks or nearby devices at first launch | Debug builds look for the development server on the local network. It does not come from the call. |
| On iPhones sold in mainland China, an "Allow to use wireless data" prompt at first network use | The system asks for every new app. Choose WLAN & Cellular. |
| `ping timeout triggered` or `not found in senderGetStats()` warnings after hanging up | Harmless messages from LiveKit's teardown. To quiet LiveKit's logging: `import { setLogLevel } from "livekit-client"; setLogLevel("warn");` |
| In a monorepo, odd failures after installing | Make sure only one copy of `@livekit/react-native` and `livekit-client` is installed (`npm ls @livekit/react-native livekit-client`). |
