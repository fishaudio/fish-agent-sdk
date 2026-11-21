# @fishaudio/agent-widget-react-native

A drop-in voice agent for React Native apps, for [Fish Audio](https://fish.audio) agents. One component renders a floating button that opens a call panel with a live transcript, text input, mute, client-tool activity, an optional consent step, and a minimized in-call pill. It is the React Native counterpart of the web [`<fish-agent>` widget](https://www.npmjs.com/package/@fishaudio/agent-widget), built on [`@fishaudio/agent-react-native`](https://www.npmjs.com/package/@fishaudio/agent-react-native).

The UI is ready-made. To draw your own, use `useConversation` from `@fishaudio/agent-react-native` instead.

**Full documentation:** [React Native widget](https://github.com/fishaudio/fish-agent-sdk/blob/main/docs/react-native-widget.md), covering every prop, theming, and the differences from the web widget.

## Requirements

- The [React Native SDK](https://docs.fish.audio/agents/deploy/react-native) set up first: its native dependencies, the config plugin (Expo) or the bare React Native steps, and a native build. Expo Go cannot run WebRTC.
- `react-native-svg`, which draws the icons. It is a native module, so rebuild the app after installing it.
- A backend that creates session tokens with your API key (recommended), or a public agent. Never ship the API key in the app.

## Install

```sh
npx expo install @fishaudio/agent-widget-react-native react-native-svg
```

Bare React Native: `npm install @fishaudio/agent-widget-react-native react-native-svg`, then `cd ios && pod install`.

## Use

Render it last in your root view, so it floats above the app and stays mounted across screens. Unmounting the widget ends its call.

```tsx
import { FishAgentWidget } from "@fishaudio/agent-widget-react-native";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function App() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1 }}>
      <YourApp />
      <FishAgentWidget
        sessionTokenProvider={() =>
          fetch("https://api.example.com/agent-session", { method: "POST" }).then((r) => r.json())
        }
        insets={insets}
        clientTools={{ get_device_info: () => ({ os: Platform.OS }) }}
      />
    </View>
  );
}
```

For a public agent, pass `agentId` instead of `sessionTokenProvider`. If the agent restricts origins, also pass `origin` with one of its allowed origins (experimental).

Common props:

| Prop | Description |
|---|---|
| `sessionTokenProvider` / `agentId` | How a call starts: your backend's token, or a public agent. |
| `agentName`, `greeting`, `proactiveMessage` | Header title, home screen line, bubble next to the button. A public agent's dashboard settings fill these in; props win. |
| `consent`, `consentStorage` | Ask before the first call; remember the answer across launches with e.g. AsyncStorage. |
| `clientTools`, `onCall` | Client tools for every call; adjust the session options right before a call starts. |
| `insets`, `position`, `draggable` | Safe-area insets, the corner, and whether the user can drag the button. |
| `theme`, `colorScheme` | Colors and sizes; `light`, `dark` or `system`. |
| `callNotification`, `audioOutput` | Android call notification; initial audio route. |
| `onConnect`, `onDisconnect`, `onError` | Call events. |

A ref exposes `expand()` to open the panel from your own button.

## Notes

- Tool chips show each tool call's input, output and error to the user. To keep tool data off the device, create sessions with `tool_events: false` on your backend, or set `options.toolEvents = false` in `onCall` for a public agent.
- React Native has no audio levels, so the orb and the bars animate by the agent's mode (listening, thinking, speaking) instead of following the voice.
