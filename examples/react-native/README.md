# React Native demo

A voice customer-support app ("小鱼商城语音客服") that talks to a Fish agent from React Native. It exists to test how well the realtime wire protocol works on mobile. Findings are in [FINDINGS.md](FINDINGS.md).

It uses only `@fishaudio/agent-protocol` and `livekit-client`, not `@fishaudio/agent-client`. That is how a third party would integrate from the protocol alone. `src/agent/FishCall.ts` is a thin port of the web SDK's transport and session logic.

## What it covers

- Session creation three ways: API key (dev only), a pasted session token, or a keyless public agent with a faked `Origin` header
- Voice call over LiveKit WebRTC, with the `fish.client.audio_ready` handshake
- Live transcripts for both sides (`lk.transcription`)
- Agent mode (listening / thinking / speaking), call status, reconnects
- Typed messages, with or without a spoken reply
- Mute, speaker/earpiece, interrupt, hang up
- Client tools: `show_order_card` (shows a card and waits for the user to tap) and `get_device_info`
- Tool progress chips (`tool.started/completed/failed`)
- End reason (`session.ended` or the transport fallback)
- A protocol log view with timing (room connect, agent ready, first audio, first text)

## Run it

You need Xcode (iOS) or the Android SDK (Android), and a physical device for anything involving the microphone.

```sh
pnpm install
pnpm --filter @fishaudio/agent-protocol build
cd examples/react-native
cp .env.example .env.local   # then fill it in
npx expo prebuild
npx expo run:ios --device     # or: npx expo run:android --device
```

`.env.local`:

```sh
EXPO_PUBLIC_FISH_API_KEY=sk-...       # from fish.audio/app/agents/api-keys
EXPO_PUBLIC_FISH_AGENT_ID=...         # a published agent
```

The API key ends up inside the app bundle. That is fine for a local demo and never fine for a shipped app: a real app asks its own backend for the session token.

The agent should have two client tools, `show_order_card` (arguments `order_id`, `status`, `item`) and `get_device_info` (no arguments), and a prompt that tells it when to call them.

Expo Go cannot run this app because WebRTC is a native module. `expo run:*` builds a development client.
