# React Native widget

A drop-in voice agent for React Native apps, the counterpart of the web [`<fish-agent>` widget](widget.md). One component renders a floating button that opens a call panel. The panel has a live transcript, text input, mute, client-tool activity, an optional consent step, and a minimized in-call pill. The UI is ready-made. To draw your own, use [`useConversation`](react-native.md) instead.

```tsx
import { FishAgentWidget } from "@fishaudio/agent-widget-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

export default function App() {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1 }}>
      <YourApp />
      <FishAgentWidget
        sessionTokenProvider={() => fetchTokenFromYourBackend()}
        insets={insets}
      />
    </View>
  );
}
```

Render it last in your root view so it floats above the app. It covers the screen with a layer that lets touches through, so only its button and panel catch taps.

## Install

The widget builds on the [React Native SDK](react-native.md), so set that up first: its native dependencies, the config plugin or bare React Native steps, and a rebuild. Then add the widget and `react-native-svg`, which draws its icons:

```bash
npx expo install @fishaudio/agent-widget-react-native react-native-svg
```

Bare React Native: `npm install @fishaudio/agent-widget-react-native react-native-svg`, then `cd ios && pod install`. `react-native-svg` is a native module, so rebuild the app after installing it.

## Connecting

Pass exactly one of the two:

- **`sessionTokenProvider` (recommended):** a function that asks your backend for a session token and returns it. The backend holds the API key and calls `POST /v1/agent/sessions`. It runs before every call. See [Starting a session](react-native.md#starting-a-session).
- **`agentId` with `origin` (experimental):** a public agent, with an origin on its allowlist, because an app sends no `Origin` of its own. Like the SDK's `origin` option, this may change in a minor release.

For a public agent the widget also loads the agent's widget settings from the platform (name, greeting, proactive message, consent, which features are on, UI strings). Props win over those settings.

## How it behaves

- **Button and proactive bubble.** A round button sits in the corner set by `position`. With `proactiveMessage` set, a bubble appears next to it after `proactiveDelay` seconds. Dismissing the bubble hides it until the app restarts.
- **Panel.** On phones (screens narrower than 600 pt) the panel is a full-screen sheet. On tablets it is a card in the corner. The Android back button minimizes it.
- **Starting.** "Start a voice chat" starts a voice call. The SDK asks for the microphone permission on Android, sets up the audio session, and runs the Android call service with the `callNotification` notification. Typing a message instead starts a text chat without the microphone. The mute pill can turn the microphone on later; on Android the widget asks for the permission at that point. A text chat has no Android call service, so if the user turns the microphone on there, it is silenced while the app is in the background. Voice calls started with the button keep it.
- **Consent.** With `consent` on, the first call waits for the user to agree. The answer lasts until the app restarts. To remember it across launches, pass `consentStorage`, for example AsyncStorage.
- **During a call.** The header shows the status and timer, a mute pill and a hang-up button. Minimizing keeps the call running and shows a pill with the timer and a hang-up button. Background calls work as described in [Background calls](react-native.md#background-calls).
- **After a call.** The transcript stays with a "Call ended" divider. The user can start a new call or keep typing.
- **Unmounting** the widget ends its call.

## Props

| Prop | Default | Description |
|---|---|---|
| `sessionTokenProvider` | | `() => SessionToken \| Promise<SessionToken>`, called before every call. |
| `agentId` | | Public agent ID. |
| `origin` | | Experimental. Public agents only: an origin on the agent's allowlist. |
| `serverUrl`, `userId`, `language`, `dynamicVariables` | | Session options for public agents. A backend token already carries them. |
| `agentName` | remote, else `"Agent"` | Header title. |
| `greeting` | remote, else `"Hey! How can I help?"` | Home screen line. |
| `proactiveMessage` | remote | Bubble text next to the button. |
| `proactiveDelay` | `3` | Seconds before the bubble shows. |
| `transcript`, `textInput`, `micMuting` | remote, else `true` | Turn the transcript, the text box and the mute pill on or off. |
| `consent` | remote, else `false` | Ask before the first call. |
| `consentText`, `termsUrl`, `privacyUrl` | | Consent body and links. |
| `consentKey` | `"fish-agent-consent"` | Storage key for the consent answer. |
| `consentStorage` | | `{ getItem, setItem }`, sync or async, e.g. AsyncStorage. |
| `position` | `"bottom-right"` | `bottom-right`, `bottom-left`, `top-right` or `top-left`. |
| `textContents` | | Overrides for any UI string, keyed as in `DEFAULT_TEXTS`. |
| `theme` | | Colors and sizes, see [Theming](#theming). |
| `colorScheme` | `"light"` | `light`, `dark`, or `system` to follow the device. |
| `insets` | `{}` | Safe-area insets, e.g. `useSafeAreaInsets()`. The button and sheet stay clear of them. |
| `callNotification` | `{ title: "Call in progress" }` | Android: the notification during voice calls. `false` turns off the call service. |
| `audioOutput` | `"auto"` | Initial audio route: `auto`, `speaker` or `earpiece`. |
| `clientTools` | | Client tools for every call. See [Client tools](client-tools.md). |
| `onCall(options)` | | Runs right before a call starts. Change `options` to adjust anything, including `callbacks`. |
| `onConnect({ sessionId })` | | The call connected. |
| `onDisconnect({ reason })` | | The call ended. |
| `onError({ code, message, stage?, recovered? })` | | A start failed or the call reported an error. Codes are in [Errors](errors.md). |
| `style` | | Style of the full-screen layer, e.g. a `zIndex`. |

A ref exposes `expand()`, which opens the panel as a tap on the button does:

```tsx
const widget = useRef<FishAgentWidgetHandle>(null);
<FishAgentWidget ref={widget} sessionTokenProvider={getToken} />;
<Button title="Help" onPress={() => widget.current?.expand()} />;
```

## Theming

`theme` takes any subset of these keys, applied over the light or dark defaults:

| Key | Light default | Used for |
|---|---|---|
| `accent`, `accentText` | `#0f0e0d`, `#ffffff` | Button, primary actions, send |
| `orbColor1`, `orbColor2` | `#7cc4ff`, `#0a3f8f` | The orb gradient and its rings |
| `background`, `text`, `textSecondary`, `border` | `#ffffff`, `#141414`, `#8a8a86`, `#ebeae8` | Panel |
| `bubbleAgentBackground`, `bubbleAgentText` | `#0f0e0d`, `#ffffff` | Agent messages |
| `bubbleUserBackground`, `bubbleUserText` | `#f4f3f1`, `#141414` | User messages |
| `danger`, `live` | `#e5484d`, `#30a46c` | Hang-up and errors; live dot |
| `radius`, `fabSize`, `offset` | `20`, `60`, `20` | Card corners, button size, distance from the edges |

## Differences from the web widget

- No audio levels on React Native, so the orb and the bars animate by the agent's mode (listening, thinking, speaking) instead of following the voice.
- Colors come from `theme` instead of CSS custom properties, and there is a dark scheme.
- `consentStorage` replaces `localStorage`. Without it, consent and the dismissed bubble last until the app restarts.
- The error strings speak of the app and Settings, not the site and the browser.
- Public agents need `origin`, since apps send no `Origin`.
