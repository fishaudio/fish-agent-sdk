# iOS SDK

The iOS SDK adds voice calls with a Fish Audio agent to a native iOS app, in Swift. It behaves like the [Web SDK](README.md) and the [React Native SDK](react-native.md): the same options, events, error codes and end reasons. On top of the call it handles the microphone permission and audio routing (loudspeaker, receiver, headsets).

It has no UI. You build the screen; the SDK gives you the state to show.

> **Status.** Calls, the microphone, audio routes, and calls in the background and with the screen locked were checked on an iPhone 12. Reconnection, headsets and phone-call interruptions have not been checked yet. See [Limitations](#limitations).

## Requirements

- **iOS 15 or later.**
- **Xcode 16.3 or later.** The SDK is built on LiveKit's Swift SDK, which needs Swift 6.1 tools.
- **Your own backend** to create session tokens, or a public agent (see [Starting a session](#starting-a-session)). Do not ship an API key inside an app.
- **Tested with** LiveKit's Swift SDK 2.19.0 on an iPhone 12 with iOS 26.6 and an iPhone 16 simulator with iOS 18.5. Other versions may work but are untested.

## Install

Add the package in Xcode (File › Add Package Dependencies) with the repository's URL, or in `Package.swift`:

```swift
dependencies: [
    .package(url: "https://github.com/fishaudio/fish-agent-sdk-web.git", from: "<version>"),
],
targets: [
    .target(name: "YourApp", dependencies: [.product(name: "FishAgent", package: "fish-agent-sdk-web")]),
]
```

Use the first version that includes the iOS SDK or a later one. Older tags of the repository have no Swift package.

Add two things to the app's `Info.plist`:

- `NSMicrophoneUsageDescription`, the sentence iOS shows when it asks for the microphone. iOS ends an app that uses the microphone without it.
- The `audio` background mode (`UIBackgroundModes`), so a call continues in the background and with the screen locked.

## Starting a session

An app starts a call in one of two ways, the same two the Web SDK offers.

### From your backend (recommended)

The app asks your backend for a session token when the user starts a call. The backend calls `POST /v1/agent/sessions` with your API key and returns the response as is. [Authenticated sessions](authentication.md) has backend examples in Node and Python. The same endpoint serves web and mobile.

Pass the response body to the SDK without picking fields out of it:

```swift
let token = try SessionToken(json: responseBody)
try await conversation.startSession(.sessionToken(token))
```

On a phone, `localhost` is the phone, not your computer: use your computer's LAN address during development. iOS also blocks plain `http://` unless the app allows it (`NSAllowsLocalNetworking` covers the local network). Serve the token endpoint over HTTPS in production.

### Public agent

An agent with public access enabled takes sessions without a key or a backend. Pass its ID:

```swift
try await conversation.startSession(.agentId("your-agent-id"))
```

If the agent has **Restrict origins** on, the server checks the request's `Origin` against the agent's allowed origins. An app sends none, so pass one that is on the list:

```swift
try await conversation.startSession(.agentId("your-agent-id")) {
    $0.origin = "https://www.example.com"
}
```

Without it, a restricted agent answers `origin_forbidden`.

> **Experimental.** The `origin` option may change or be removed in a minor release: a dedicated way for apps to identify themselves may replace it.

Anyone with the agent ID can start sessions, billed to the agent's owner. For a production app, especially one with signed-in users, prefer your backend: it decides who gets a token and can pass `end_user_id`. [React Native SDK](react-native.md#public-agent) says more about what a public agent exposes; all of it applies here.

## Quick start

```swift
import FishAgent
import SwiftUI

struct CallView: View {
    @StateObject private var conversation = Conversation()

    var body: some View {
        VStack {
            Text(conversation.status.rawValue)
            ForEach(conversation.messages) { message in
                Text(message.text)
            }
            Button("Start call") {
                Task {
                    do {
                        let token = try SessionToken(json: try await fetchTokenFromYourBackend())
                        try await conversation.startSession(.sessionToken(token))
                    } catch is CancellationError {
                        // The user hung up while the call was starting.
                    } catch let error as FishAgentError {
                        showError(error.code, error.message)
                    }
                }
            }
            Button("Hang up") {
                Task { try? await conversation.endSession() }
            }
        }
    }
}
```

`startSession` asks for the microphone permission if the user has not been asked yet. The example app in [`examples/ios`](../examples/ios) is one screen that does all of this.

## `Conversation`

One object for the app's calls, an `ObservableObject` on the main actor. It can make any number of calls, one at a time.

```swift
Conversation(defaults: SessionOptions = .init(), mobile: MobileOptions = .init())
```

| Member | |
|---|---|
| `status: ConversationStatus` | `idle` before the first call and after a failed start. Stays `ended` after a call until the next one starts. |
| `mode: AgentMode` | What the agent is doing. |
| `micMuted: Bool` | |
| `audioOutput: AudioOutputRoute` | The route that was asked for, not the device audio is playing on. |
| `messages: [ChatMessage]` | The chat log of the current call, streaming entries included (`isFinal` is false while one is streaming). It stays after the call and is emptied when the next call starts. |
| `endReason: EndReason?` | Why the last call ended. |
| `events() -> AsyncStream<ConversationEvent>` | What happened. Each call returns a stream of its own; see below. |
| `sessionId`, `isSpeaking` | |
| `startSession(_:configure:) async throws -> String` | Starts a call. Returns the session ID once connected. |
| `endSession() async throws` | Hangs up. Safe at any time. |
| `setMicMuted(_:) async throws` | |
| `sendUserMessage(_:audio:)` | A typed message. The agent answers in text only unless `audio` is true. |
| `sendUserActivity()`, `interrupt()` | |
| `setAudioOutput(_:)` | `.auto`, `.speaker` or `.earpiece`, during a call or before one. |
| `registerClientTool(_:handler:)` | For the current call and every later one. |
| `transcript()` | |

The first six are `@Published`. `SessionOptions` has the same fields as the Web SDK's [session options](sessions.md): `origin`, `serverUrl`, `language`, `timezone`, `context`, `overrides`, `dynamicVariables`, `endUserId`, `metadata`, `toolEvents`, `clientTools`, `clientToolTimeout` and `microphone`. `MobileOptions` adds `audioOutput`.

The same rules as the other SDKs:

- A second `startSession` while one is on its way, or during a live call, joins that call.
- `endSession` during a start cancels it: `startSession` throws `CancellationError`, and the session, if one was created, is closed.
- A failed start puts `status` back to `idle`.
- `sendUserMessage`, `sendUserActivity` and `interrupt` do nothing when there is no call.
- The start belongs to the conversation. Cancelling the task that called `startSession` (a SwiftUI `.task` whose view went away, for one) stops the wait, not the call. Call `endSession` to hang up. Releasing the `Conversation` also ends its call.

**Events.** `events()` carries the same events as the Web SDK's [event reference](events.md), as cases of `ConversationEvent`. Each call to `events()` makes a new stream, so several parts of an app can listen. Nothing is replayed: an event from before the stream was made is gone, so read state from the published properties. A consumer that falls more than 256 events behind loses the oldest ones.

**One call per app.** Only one call can run in a process at a time, whichever `Conversation` makes it. A second conversation's `startSession` throws `ConversationUsageError.callAlreadyActive` until the first call has ended. The audio session is shared by the whole process.

**Left out.** As in the React Native SDK, the browser-only members are not there: `startAudio`, `setOutputVolume`, `setInputDevice`, `setOutputDevice`, audio levels, and the screen wake lock. There is also no `getRoom()`: no LiveKit type appears in the SDK's API, so your app can move to a newer LiveKit 2.x without the SDK changing.

## Client tools

A tool is an async closure from the arguments to a result:

```swift
var options = SessionOptions()
options.clientTools = [
    "get_cart": { _, _ in
        ["items": .number(Double(cart.items.count)), "total": .number(cart.total)]
    },
]
let conversation = Conversation(defaults: options)
```

Arguments and results are `JSONValue`, which can be written with literals. Returning `nil` sends no result. Throwing reports a failure to the agent. Handlers do not run on the main actor; mark the closure `@MainActor` to touch the UI. The timeout and size rules are the ones in [Client tools](client-tools.md).

## Audio

LiveKit configures, activates and deactivates the app's audio session by itself as a call's audio starts and stops. The SDK does not touch activation. It states a route preference, and when the call ends it sets the session's category back to the system default, because LiveKit leaves the call category behind and other audio in the app would otherwise play quieter and ignore the silent switch.

During a call the session is `playAndRecord`, in video-chat mode on the speaker and voice-chat mode on the receiver. If your app plays other audio, expect its audio session to be reconfigured for the length of a call.

## Limitations

- **Not checked yet:** reconnection after a network outage, moving between Wi-Fi and cellular, wired and Bluetooth headsets, and an incoming phone call during a call. [`examples/ios/README.md`](../examples/ios/README.md) lists what was checked on an iPhone and what was not. The reconnect rules are the ones verified on Android.
- **The opening line can be missed.** In 5 of 25 calls on a simulator, LiveKit's first connection attempt failed and was retried by itself; the agent had already spoken its opening line to an app that was not connected yet. The rest of the call worked. It did not happen in 6 calls on an iPhone, which is too few to rule it out.
- **On the simulator**, unmuting a call that started without the microphone fails with `connection_failed`, and hanging up can take about 2.5 seconds. Both work on an iPhone.
- **No audio levels.** There is nothing to drive a waveform or an orb from.
- **`audioOutput` is the route that was asked for**, not the active device, and there is no event when the route changes.
- **Phone calls, Bluetooth and other interruptions are not handled.** What LiveKit does by default is what happens.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The package does not resolve | Xcode is older than 16.3, or the version is older than the first one with the iOS SDK. |
| The app is ended when a call starts | `NSMicrophoneUsageDescription` is missing from `Info.plist`. |
| `mic_permission_denied` | The user refused the microphone. iOS does not ask twice: send them to Settings. |
| `ConversationUsageError.callAlreadyActive` | Only one call runs per app. End the other call, or use one `Conversation` for the app. |
| A public agent fails with `origin_forbidden` | The agent restricts origins. Pass `origin`, matching one of its allowed origins exactly (scheme, host and port). |
| The token request fails on an iPhone | `localhost` is the phone. Use your computer's LAN address, and allow local networking or use HTTPS. On the first run iOS also asks whether the app may reach the local network; until that is allowed, requests to it fail as if the phone were offline. Add `NSLocalNetworkUsageDescription` to explain the prompt. |
| The call stops in the background | The `audio` background mode is missing from `Info.plist`. |
