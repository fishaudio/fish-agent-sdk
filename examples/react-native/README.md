# React Native demo

A voice customer-support app ("小鱼商城语音客服") that talks to a Fish agent from React Native. It exists to test how well the realtime wire protocol works on mobile. Findings are in [FINDINGS.md](FINDINGS.md).

It is built on `@fishaudio/agent-react-native` (`packages/react-native`): the call itself is the SDK's `useConversation`, and `src/agent/useAgentCall.ts` adds the demo's UI state, client tools and a protocol log. The first round of testing used a hand-written client on the raw protocol instead; it is in git history (commit b2bd550, `src/agent/FishCall.ts`).

## What it covers

- Both supported ways to start a call:
  - **Your backend (recommended):** the app asks `server/index.mjs` for a session token; the server holds the API key and picks the agent, and the app never sees the key.
  - **Public agent (experimental):** keyless, with the agent ID and an origin on the agent's allowlist (`startSession({ agentId, origin })`). Anyone with the ID can do the same; see FINDINGS.md P1-6.
- Voice call over LiveKit WebRTC, with the `fish.client.audio_ready` handshake
- Live transcripts for both sides (`lk.transcription`)
- Agent mode (listening / thinking / speaking), call status, reconnects
- Typed messages, with or without a spoken reply
- Mute, speaker/earpiece (headsets win in auto), interrupt, hang up
- Background calls: iOS background audio, Android microphone foreground service
- Client tools: `show_order_card` (shows a card and waits for the user to tap) and `get_device_info`
- Tool progress chips (`tool.started/completed/failed`)
- End reason (`session.ended` or the transport fallback)
- A protocol log view with timing (room connect, agent ready, first audio, first text)

## Run it

You need Xcode (iOS) or the Android SDK (Android), and a physical device for anything involving the microphone.

```sh
pnpm install
pnpm build                   # the example imports the SDK packages from their dist/
cd examples/react-native
```

1. Start the token backend. It is the only place with the API key:

   ```sh
   cp server/.env.example server/.env.local   # FISH_API_KEY and FISH_AGENT_ID
   pnpm server                                # POST http://<this computer>:3001/agent-session
   ```

2. Point the app at it. On a phone, `localhost` is the phone itself:

   ```sh
   cp .env.example .env.local
   # Android: adb reverse tcp:3001 tcp:3001, then EXPO_PUBLIC_TOKEN_URL=http://localhost:3001/agent-session
   # iOS:     EXPO_PUBLIC_TOKEN_URL=http://<your computer's LAN address>:3001/agent-session
   ```

   The address can also be changed on the app's home screen.

3. Build and run:

   ```sh
   npx expo prebuild
   npx expo run:ios --device     # or: npx expo run:android --device
   ```

`server/index.mjs` is a minimal stand-in for your backend. A real one would also check who the user is and rate-limit them before handing out a token, and pass that identity as `end_user_id`. The [authentication guide](../../docs/authentication.md) has Node and Python versions.

The agent should have two client tools, `show_order_card` (arguments `order_id`, `status`, `item`) and `get_device_info` (no arguments), and a prompt that tells it when to call them.

Expo Go cannot run this app because WebRTC is a native module. `expo run:*` builds a development client.
