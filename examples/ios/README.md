# Fish Agent iOS example

One screen that starts a voice call with an agent, shows the conversation, and lets you type, mute, switch the audio output and hang up. It uses the Swift package at the root of this repository.

The app never holds the Fish API key. It asks a backend for a session token and passes the response to the SDK.

## Run it

1. Start the token backend. It is the only place with the API key. The React Native example has one you can use as it is:

   ```sh
   cd examples/react-native
   cp server/.env.example server/.env.local   # FISH_API_KEY and FISH_AGENT_ID
   node --env-file=server/.env.local server/index.mjs
   ```

   It listens on port 3001. The agent needs a published version.

2. Open `examples/ios/FishAgentExample.xcodeproj` in Xcode (16.3 or later) and run it on a simulator.

   On a simulator the app reaches the backend at `http://127.0.0.1:3001/agent-session`. On an iPhone, set `FishAgentTokenURL` in `Info.plist` to the address of your machine on the local network, and pick your development team under Signing & Capabilities.

3. Tap **Start call** and allow the microphone.

## What to look at

[`FishAgentExampleApp.swift`](FishAgentExample/FishAgentExampleApp.swift) is the whole app:

- `startCall` fetches a session token and starts the call. The SDK asks for the microphone permission.
- The view reads `status`, `mode`, `micMuted` and `messages` straight from the `Conversation`.
- The `get_device_info` client tool is passed when the `Conversation` is created. Add a client tool with that name to your agent to see it called.
- `startPublicCall` shows a public agent, which needs no backend.

`Info.plist` has what an app of your own needs too: `NSMicrophoneUsageDescription`, and the `audio` background mode so a call continues in the background. `NSAllowsLocalNetworking` is for the local backend over plain http during development. Remove it in an app of your own.

## Scripted checks

Debug builds run a script of commands from the `FISH_EXAMPLE_SCRIPT` environment variable, so a call can be checked without touching the screen. Every state change and event is printed to the app's console with the prefix `FishExample`.

```sh
xcrun simctl privacy booted grant microphone audio.fish.agent.example
SIMCTL_CHILD_FISH_EXAMPLE_SCRIPT="start; wait 12; msg Where is my order?; wait 10; hangup" \
  xcrun simctl launch --console booted audio.fish.agent.example
```

Commands: `start`, `start-text` (no microphone), `start-public agentId|serverUrl|origin`, `hangup`, `mute`, `unmute`, `msg <text>`, `interrupt`, `route auto|speaker|earpiece`, `wait <seconds>`, `audio` (prints the audio session). `FISH_AGENT_TOKEN_URL` overrides the token backend's address.

## What has been checked

On an iPhone 16 simulator (iOS 18.5), on 2026-11-21, against a production agent:

| Check | Result |
|---|---|
| A call connects, the opening line plays and its transcript arrives | Pass in most calls. See "Known problems" for the rest. |
| A typed message is sent and answered | Pass |
| Mute and unmute during a call that started with the microphone | Pass |
| Switching between auto, speaker and earpiece during a call | The audio session's options change as expected (default-to-speaker on for auto and speaker, off for earpiece). Where audio actually plays cannot be heard on a simulator. |
| After hanging up, the audio session category is back to the system default | Pass |
| A second call in the same app run | Pass |
| A call ended by the backend ends the call in the app | Pass |
| A public-agent request sends `Origin` when given and leaves it out otherwise | Pass (against a local server that echoes the headers) |
| The Release configuration builds | Pass (built, not run) |

### Known problems

- **Unmuting a call that started without the microphone fails.** `start-text`, then `unmute`: the SDK throws `connection_failed` ("Could not toggle the microphone"). Underneath, LiveKit reports audio engine error -4010 when recording is added while the agent's audio is already playing. Trying again, and preparing recording first, did not help. Not known yet whether an iPhone behaves the same.
- **In 5 of 25 calls the opening line was missed.** LiveKit's first connection attempt failed and was retried by itself. The server had already counted the app as in the room, so the agent spoke its opening line before the app was really connected: neither the audio nor the transcript arrived. The rest of the call worked. This is between LiveKit's connect retry and the runtime; the SDK cannot make up for it.
- **Hanging up takes about 2.5 seconds** before the call reads as ended, in some calls. That is how long LiveKit takes to leave the room.

### Not checked yet

On a physical iPhone, none of the above. These in particular need a phone:

- Audio is heard from the loudspeaker, the receiver, and a wired or Bluetooth headset as selected.
- The microphone captures on the second call of an app run. (On the simulator the second call connects and publishes the microphone.)
- The call continues in the background and with the screen locked.
- An incoming phone call during a call: whether the microphone is released, whether the call resumes, and how it ends.
- Network outages and moving between Wi-Fi and cellular. The simulator shares the Mac's network, so none of this could be tried.

Also not checked: a client tool called by a real agent (the agent used has none configured; the tool path is covered by unit tests).
