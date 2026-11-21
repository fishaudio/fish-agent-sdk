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

Against a production agent, on 2026-11-21.

### On an iPhone 12 (iOS 26.6.1)

The microphone was checked by playing a sentence from a computer's speakers next to the phone and reading the user's transcript.

| Check | Result |
|---|---|
| A call connects, the opening line plays and its transcript arrives | Pass (6 of 6 calls) |
| The microphone captures: speech near the phone arrives as the user's transcript and the agent answers it | Pass |
| Switching the audio output during a call | Pass. The session's route is the receiver for `earpiece` and the speaker for `speaker` and `auto`. Not listened to. |
| A call started without the microphone, then unmuted | Pass. Speech after the unmute is transcribed and answered. |
| The microphone captures on the second and third call of one app run | Pass |
| With the app in the background, the agent still hears the user | Pass |
| With the screen locked, the agent still hears the user | Pass |
| After hanging up, the audio session category is back to the system default | Pass |
| Hanging up | The call reads as ended about 0.3 seconds later. |

The first run on a phone shows two more system prompts before the microphone one: local network access (the token backend is on the local network), and on iPhones sold in mainland China, wireless data. Until both are allowed, the token request fails as if the phone were offline.

### On an iPhone 16 simulator (iOS 18.5)

| Check | Result |
|---|---|
| A typed message is sent and answered | Pass |
| Mute and unmute during a call that started with the microphone | Pass |
| A call ended by the backend ends the call in the app | Pass |
| A public-agent request sends `Origin` when given and leaves it out otherwise | Pass (against a local server that echoes the headers) |
| The Release configuration builds | Pass (built, not run) |

### Known problems

- **The opening line can be missed.** In 5 of 25 calls on the simulator, LiveKit's first connection attempt failed and was retried by itself. The server had already counted the app as in the room, so the agent spoke its opening line before the app was really connected: neither the audio nor the transcript arrived. The rest of the call worked. It did not happen in 6 calls on the iPhone, which is too few to say it cannot. This is between LiveKit's connect retry and the runtime; the SDK cannot make up for it.
- **On the simulator only:** unmuting a call that started without the microphone fails with `connection_failed` (LiveKit reports audio engine error -4010), and hanging up can take about 2.5 seconds. Neither happens on the iPhone.

### Not checked yet

- Audio was not listened to. The route the audio session reports was read instead.
- A wired or Bluetooth headset.
- An incoming phone call during a call: whether the microphone is released, whether the call resumes, and how it ends.
- Network outages and moving between Wi-Fi and cellular. Nothing about reconnection has been tried on iOS.
- A client tool called by a real agent (the agent used has none configured; the tool path is covered by unit tests).
