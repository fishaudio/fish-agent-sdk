# Fish Agent Android example

One screen that starts a voice call with an agent, shows the conversation, and lets you type, mute, switch the audio output and hang up. It uses the Android SDK in [`android/`](../../android) of this repository.

The app never holds the Fish API key. It asks a backend for a session token and passes the response to the SDK.

## Run it

1. Start the token backend. It is the only place with the API key. The React Native example has one you can use as it is:

   ```sh
   cd examples/react-native
   cp server/.env.example server/.env.local   # FISH_API_KEY and FISH_AGENT_ID
   node --env-file=server/.env.local server/index.mjs
   ```

   It listens on port 3001. The agent needs a published version.

2. Open `examples/android` in Android Studio and run the `app` configuration on an emulator, or from a terminal:

   ```sh
   cd examples/android
   ./gradlew :app:installDebug
   ```

   On an emulator the app reaches the backend at `http://10.0.2.2:3001/agent-session`. On a phone, pass the address of your machine on the local network:

   ```sh
   ./gradlew :app:installDebug -PfishAgent.tokenUrl=http://192.168.1.20:3001/agent-session
   ```

3. Tap **Start call** and allow the microphone.

## What to look at

[`MainActivity.kt`](app/src/main/kotlin/com/fishaudio/agent/example/MainActivity.kt) is the whole app:

- `startCall` asks for the microphone permission, fetches a session token and starts the call.
- `observe` turns the conversation's flows (`status`, `mode`, `micMuted`, `messages`) into what is on screen.
- The `get_device_info` client tool is registered when the `Conversation` is created. Add a client tool with that name to your agent to see it called.
- `startPublicCall` shows a public agent, which needs no backend.

Two things in the project are for development only. Remove them in an app of your own: `android:usesCleartextTraffic` in the manifest (for the local backend over plain http), and the `includeBuild` block in `settings.gradle.kts` (an app gets the SDK from Maven Central).

The release build is minified with R8 and needs no extra rules for the SDK.

## Scripted checks

Debug builds can be driven with `adb`, so a call can be checked without touching the screen. Every state change and event is logged under the tag `FishExample`.

```sh
adb logcat -s FishExample &
adb shell am start -n com.fishaudio.agent.example/.MainActivity --es cmd start
adb shell "am start -n com.fishaudio.agent.example/.MainActivity --es cmd msg --es text 'Where is my order?'"
adb shell am start -n com.fishaudio.agent.example/.MainActivity --es cmd hangup
```

Commands: `start`, `start-text` (no microphone), `start-public` (text is `agentId|serverUrl|origin`), `hangup`, `mute`, `unmute`, `msg`, `interrupt`, `route` (text is `auto`, `speaker` or `earpiece`). Grant the microphone first with `adb shell pm grant com.fishaudio.agent.example android.permission.RECORD_AUDIO`. To keep the commands in a release build, add `-PfishAgent.automation=true`.

## What has been checked

On an Android 16 emulator (API 36, arm64), on 2026-11-21, against a production agent:

| Check | Result |
|---|---|
| A call connects, the opening line plays and its transcript arrives | Pass |
| A typed message is sent and answered | Pass |
| Mute and unmute | Pass |
| Switching between auto, speaker and earpiece during a call | The calls are accepted; where audio actually plays cannot be heard on an emulator |
| With the app in the background, the microphone foreground service is running | Pass |
| After hanging up, the service is gone | Pass |
| A second call in the same app run | Pass |
| A call started without the microphone runs no service; unmuting starts it | Pass |
| A call ended by the backend ends the call in the app and stops the service | Pass |
| Airplane mode for 12 seconds: reconnecting, then connected again | Pass |
| The minified release build completes a call | Pass |
| A public-agent request sends `Origin` when given and leaves it out otherwise | Pass (against a local server that echoes the headers) |

One start of the release build failed with a 20 second timeout in this app's own request to the local token backend, before the SDK was called. It did not happen again and the cause was not found.

### Not checked yet

On a physical phone, none of the above. These in particular need a phone, because an emulator cannot show them:

- Audio is heard from the loudspeaker, the earpiece, and a wired or Bluetooth headset as selected.
- The agent keeps hearing the user while the app is in the background or the screen is locked.
- An incoming phone call during a call: whether the microphone is released, whether the call resumes, and how it ends.
- Moving between Wi-Fi and cellular.

Also not checked: a client tool called by a real agent (the agent used has none configured; the tool path is covered by unit tests), and Bluetooth, which needs the app to hold `BLUETOOTH_CONNECT` on Android 12 and later.
