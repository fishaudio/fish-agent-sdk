# Fish Agent SDK

Embed [Fish Audio](https://fish.audio) voice agents into websites, web apps, React Native apps, and native iOS and Android apps: realtime voice over WebRTC, live transcripts, text chat, and client tools. The API is small and event-driven.

Public documentation: [Web SDK](https://docs.fish.audio/agents/deploy/web-sdk), [React SDK](https://docs.fish.audio/agents/deploy/react-sdk), [React Native SDK](https://docs.fish.audio/agents/deploy/react-native), [Widget](https://docs.fish.audio/agents/deploy/widget). The in-repo notes under [`docs/`](docs/README.md) track the source.

| Package | Docs | Description |
|---|---|---|
| `@fishaudio/agent-client` | [docs](docs/README.md#fishaudioagent-client) | Framework-agnostic JS SDK. Sessions, realtime audio, transcripts, client tools. |
| `@fishaudio/agent-react` | [docs](docs/react/README.md) | React hooks (`useConversation`), provider, chat-log and visualizer components. |
| `@fishaudio/agent-react-native` | [docs](docs/react-native.md) | React Native hook (`useConversation`) with the microphone permission, audio routing, and background calls. Expo or bare React Native. |
| iOS SDK (Swift package `FishAgent`) | [docs](docs/ios.md) | Native iOS: a `Conversation` object with published state, the microphone permission and audio routing. Sources in [`ios/`](ios). |
| Android SDK (`com.fishaudio.agent:agent-android`) | [docs](docs/android.md) | Native Android: a `Conversation` object with `StateFlow` state, audio routing and a foreground service for background calls. Sources in [`android/`](android). |
| `@fishaudio/agent-widget` | [docs](docs/widget.md) | `<fish-agent>` custom element (plus a `<FishAgentWidget>` React component): voice-first chat card with transcript, tool chips, consent, theming. |
| `@fishaudio/agent-widget-embed` | [docs](docs/widget.md) | The widget as one CDN script. Loading it registers `<fish-agent>`. |
| `@fishaudio/agent-protocol` | [README](packages/protocol/README.md) | Semi-internal wire contract for realtime messages and session creation. Dependency-free. Apps consume it via `agent-client`. |

### Widget (no build step)

```html
<fish-agent agent-id="your-agent-id"></fish-agent>
<script src="https://unpkg.com/@fishaudio/agent-widget-embed" async type="text/javascript"></script>
```

## Quickstart

Two ways to start a call, depending on whether the agent is public.

### Authenticated agents

The session is created on your server (which holds your API key) and joined from the browser.

**1. Server:** create a short-lived session token and return it to the browser.

```js
// e.g. POST /api/voice-session
app.post("/api/voice-session", async (req, res) => {
  const response = await fetch("https://api.fish.audio/v1/agent/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FISH_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agent_id: process.env.FISH_AGENT_ID }),
  });
  res.status(response.status).json(await response.json());
});
```

**2. Browser:** fetch the token from your server when the call starts, then join. The token is short-lived, so don't fetch it at page load. `AgentSession.start` requests microphone access, streams the mic to the agent, and plays the agent's voice through the speakers. Browsers only allow that from a user gesture, so call it from a click handler.

```js
import { AgentSession } from "@fishaudio/agent-client";

const sessionToken = await fetch("/api/voice-session", { method: "POST" }).then((r) => r.json());

const session = await AgentSession.start({
  sessionToken,
  callbacks: {
    onModeChange: (mode) => console.log(mode), // listening | thinking | speaking
    onMessage: ({ role, text }) => console.log(role, text),
  },
});
```

### Public agents

A public agent needs no server. Enable public access on the agent in the dashboard (to limit it to your sites, also turn on Restrict origins and list your page origin). Then start the session in the browser with the `agentId`. `start` still uses the mic and speaker, so call it from a click handler.

```js
import { AgentSession } from "@fishaudio/agent-client";

const session = await AgentSession.start({
  agentId: "your-agent-id",
  callbacks: {
    onModeChange: (mode) => console.log(mode), // listening | thinking | speaking
    onMessage: ({ role, text }) => console.log(role, text),
  },
});
```

See [Sessions](docs/sessions.md), [Events](docs/events.md), [Client tools](docs/client-tools.md) and [Errors](docs/errors.md) for the full reference.

## React Integration

[`@fishaudio/agent-react`](docs/react/README.md) wraps the client SDK in a `useConversation` hook (plus a provider, a chat-log hook, and an audio-visualizer component). The hook owns the session lifecycle, re-renders on state changes, and ends the call automatically when the component unmounts.

```tsx
"use client";

import { useConversation } from "@fishaudio/agent-react";

export function CallButton() {
  const conversation = useConversation();

  const start = async () => {
    const sessionToken = await fetch("/api/voice-session", { method: "POST" }).then((r) => r.json());
    await conversation.startSession({ sessionToken }); // or { agentId } for a public agent
  };

  return conversation.status === "connected" ? (
    <button onClick={() => conversation.endSession()}>
      End call{conversation.isSpeaking ? " · speaking" : ""}
    </button>
  ) : (
    <button onClick={start}>Start call</button>
  );
}
```

See the [react docs](docs/react/README.md) for the full hook API, the [provider pattern](docs/react/provider.md), and the ready-made components.

## React Native

[`@fishaudio/agent-react-native`](docs/react-native.md) brings the same `useConversation` hook to iOS and Android apps, and handles what phones need: the microphone permission, the audio session and routing, and calls that keep going in the background. It works with Expo and with bare React Native. WebRTC is a native module, so the app needs a native build (not Expo Go), and testing the microphone needs a real device.

```sh
npx expo install @fishaudio/agent-react-native @livekit/react-native @livekit/react-native-webrtc \
  @livekit/react-native-expo-plugin @config-plugins/react-native-webrtc livekit-client
npx expo run:ios --device   # or run:android
```

Call `setupFishAgent()` in a module of its own and import it first in your entry file, so the WebRTC globals are installed before your app's modules load:

```ts
// setupFishAgent.ts
import { setupFishAgent } from "@fishaudio/agent-react-native";
setupFishAgent();

// index.ts
import "./setupFishAgent";
import "expo-router/entry"; // or your registerRootComponent(App) entry
```

Then start a call from a button. As on the web, the app gets a session token from your backend, which keeps the API key:

```tsx
import { useConversation } from "@fishaudio/agent-react-native";
import { Button } from "react-native";

export function CallButton() {
  const conversation = useConversation({}, { callNotification: { title: "Talking to support" } });

  const start = async () => {
    const sessionToken = await fetch("https://api.example.com/voice-session", { method: "POST" }).then((r) => r.json());
    await conversation.startSession({ sessionToken }); // or { agentId } for a public agent
  };

  return conversation.status === "connected" ? (
    <Button title="End call" onPress={() => void conversation.endSession()} />
  ) : (
    <Button title="Start call" onPress={() => void start()} />
  );
}
```

See the [React Native docs](https://docs.fish.audio/agents/deploy/react-native) for bare React Native setup, background calls, audio routes, and troubleshooting.

## iOS

Add the package in Xcode with this repository's URL, then:

```swift
import FishAgent

@StateObject private var conversation = Conversation()

// The session token comes from your backend, as in the quickstart above.
let token = try SessionToken(json: responseBody)
try await conversation.startSession(.sessionToken(token))
```

`conversation.status`, `mode` and `messages` are published properties for SwiftUI. See the [iOS docs](docs/ios.md) and the example app in [`examples/ios`](examples/ios).

## Android

```kotlin
dependencies {
    implementation("com.fishaudio.agent:agent-android:<version>")
}
```

```kotlin
val conversation = Conversation(context)

if (FishAgentPermissions.requestMicrophonePermission(activity)) {
    val token = SessionToken.fromJson(responseBody)
    conversation.startSession(SessionAuth.Token(token))
}
```

`conversation.status`, `mode` and `messages` are `StateFlow`s. The app also needs the JitPack repository, for a dependency of LiveKit. See the [Android docs](docs/android.md) and the example app in [`examples/android`](examples/android).

Both native SDKs have been checked on a simulator and an emulator only so far; their docs list what is still to be checked on phones.

## License

MIT
