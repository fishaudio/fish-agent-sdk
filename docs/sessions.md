# Sessions

An `AgentSession` is one live call: it owns the realtime connection, the microphone, and playback. Create it with `AgentSession.start(options)`; it resolves once connected.

```js
import { AgentSession } from "@fishaudio/agent-client";

const session = await AgentSession.start({
  sessionToken, // from your backend; see Authentication
  callbacks: {
    onModeChange: (mode) => setOrbState(mode), // "listening" | "thinking" | "speaking"
    onUserTranscript: ({ text, final }) => renderUserBubble(text, final),
    onAgentResponseDelta: ({ text }) => renderAgentBubble(text),
    onDisconnect: ({ reason }) => showCallEnded(reason),
    onError: (error) => console.error(error),
  },
});

// Later:
session.sendUserMessage("Can you summarize that?");
await session.end();
```

Starting a session requests microphone access. Call `start()` from a user gesture such as a button click for the best permission and autoplay behavior. For a text-first UI, pass `microphone: false` to join without the microphone. Then there is no permission prompt at start. The first `setMicMuted(false)` captures the mic instead, so call *that* from a user gesture.

## `AgentSession.start(options)`

| Option | Type | Description |
|---|---|---|
| `agentId` | `string` | Public agent id. Exactly one of `agentId` / `sessionToken` is required. |
| `sessionToken` | `SessionToken` | Server-created session token, passed through verbatim. |
| `serverUrl` | `string` | Fish API base for `agentId` mode. Default `https://api.fish.audio`. |
| `language` | `string` | Shorthand for `overrides.language`. Gated by the same allowlist. `agentId` mode only. |
| `timezone` | `string` | IANA timezone anchoring the agent's sense of local time. Omit to use the browser's timezone, sent automatically as a hint (`agentId` mode only). |
| `worldContext` | `boolean` | The agent knows the current date and time by default; set `false` to withhold both (`agentId` mode only). |
| `overrides` | `SessionOverrides` | Per-session config replacement; see [Customization](customization.md). |
| `dynamicVariables` | `Record<string, string \| number \| boolean>` | `{{name}}` template values. |
| `endUserId` | `string` | Your user identifier, for attribution (`agentId` mode only). |
| `metadata` | `object` | Free-form key-values stored on the session record (`agentId` mode only). |
| `toolEvents` | `boolean` | Stream the agent's tool-call lifecycle, with payloads, to this session. See [Events](events.md#tool-call-lifecycle). Default `true`. Set `false` to keep tool data off the client. `agentId` mode only. With `sessionToken` auth, your backend passes `tool_events` when creating the session. |
| `clientTools` | `Record<string, ClientToolHandler>` | Handlers the agent can invoke in the browser. See [Client tools](client-tools.md). |
| `clientToolTimeoutMs` | `number` | Per-tool handler timeout. Default `15000`. |
| `microphone` | `boolean` | Capture the mic on start. Default `true`. `false` joins muted without a permission prompt; the first `setMicMuted(false)` captures it. |
| `audio.inputDeviceId` | `string` | Microphone device to capture from. |
| `audio.outputDeviceId` | `string` | Playback device (`setSinkId`). `start()` rejects with `device_change_failed` where the browser doesn't support output selection (common on mobile; checked before a server session is created) or the device can't be used (checked before connecting). |
| `wakeLock` | `boolean` | Hold a screen wake lock while the session is live, so long calls survive the phone trying to sleep. Default `true`; denial (battery saver, unsupported browser) is silent. |
| `playoutProbe` | `boolean` | Report the turn latency as the caller's ear has it, measured in the browser (see [Playout probe](#playout-probe)). Default `true`. |
| `callbacks` | `Partial<AgentSessionCallbacks>` | Shorthand for `.on(...)`. Each `onXxx` key subscribes the `xxx` event, so `onUserTranscript` subscribes `userTranscript`. An unknown key makes `start()` throw a `TypeError`. |

Returns a connected `AgentSession`. Rejects with a [`FishAgentError`](errors.md) if session creation, permissions, or the connection fail.

## Session API

```ts
// Conversation
session.sendUserMessage(text);       // typed user turn; text-only reply by default (no TTS, transcript still streams)
session.sendUserMessage(text, { audio: true }); // have the agent speak its reply for this turn
// Messages typed before the agent finishes joining are held and delivered
// in order once it's ready, so it is safe to call right after start().
session.sendUserActivity();          // "user is typing"; suppresses agent barge-in briefly
session.interrupt();                 // explicitly cut the agent off
session.getTranscript();             // [{ segmentId, role, text, final }] in order.
                                     // Seed a late-subscribing UI, then apply live events by segmentId.
session.registerClientTool(name, handler);

// Audio
await session.setMicMuted(true);   // After a microphone:false start, the first unmute captures the mic.
                                   // That prompts for permission, so call it from a user gesture.
                                   // Denial rejects with mic_permission_denied.
await session.startAudio();          // call inside a user gesture if autoplay was blocked
session.setOutputVolume(0.5);        // 0..1 playback volume
await session.setInputDevice(id);    // switch microphone mid-call (device ids from
                                     // navigator.mediaDevices.enumerateDevices());
                                     // on failure switches back to the previous mic (best effort)
await session.setOutputDevice(id);   // route playback elsewhere ("" = default device).
                                     // Rejects with device_change_failed where unsupported,
                                     // which is common on mobile. Playback then stays where it was.
session.getInputVolume();            // mic RMS 0..1, for level meters
session.getOutputVolume();           // agent RMS 0..1
session.getInputFrequencyData();     // Uint8Array FFT, for visualizers
session.getOutputFrequencyData();

// Lifecycle & state
await session.end();                 // graceful hangup; idempotent
session.sessionId; session.status; session.mode;
session.isSpeaking; session.micMuted; session.endReason;

// Escape hatch. Read Transports below before reaching for this.
session.getRoom();                   // underlying livekit-client Room; undefined once ended
```

## Lifecycle

`status` moves through `"connecting" → "connected" ⇄ "reconnecting" → "ended"`, surfaced by the `statusChange` event.

`start()` resolves once the realtime connection is up. The agent itself joins moments later and announces when it is live. If it never does (within 15 s), the session emits a `connection_failed` error and ends with reason `"connection_lost"` instead of idling on a dead call.

### Audio readiness

The SDK reports playback readiness to the agent. Right after joining, the session announces that it will report, and once the agent's audio track is attached and the browser has allowed playback it reports ready. Where the runtime supports this handshake, the agent holds its opening line until the report arrives. That wait is bounded, about 1.5 seconds, so a page that never gets there only delays the opening line. Elsewhere the opening line plays right away, as before. Nothing to call, the SDK does this on its own, with or without a microphone.

Autoplay policies are the one thing to watch. A browser can refuse playback until a user gesture, in which case the session stays unready and the opening line plays before anyone hears it. Starting the session from a click avoids the block in the first place. If playback was still blocked, call `session.startAudio()` from a user gesture: it unlocks playback and sends the readiness report.

### Playout probe

The runtime measures a turn's voice-to-voice latency from its own view: the caller's speech end as its detector saw it to the moment its audio leaves for the room. The microphone's path up, the network down, the browser's jitter buffer and the audio output add to what the caller experiences. To measure that, the SDK watches both ends in the browser: the microphone (the caller's speech ends, a sample within 100 ms of agent sound ignored as the speakers' leak) and the agent's voice track (the first sample of each stretch of agent speech as it leaves the decoder, plus the output latency). Each stretch is reported with the time since the caller last spoke, both on the browser's clock, so no clock sync is involved and both network legs are in. The voice track's WebRTC stats (round trip to the media edge, jitter buffer delay) go along every 2 s. The runtime keeps the number as the turn's heard voice-to-voice, which the console's turn latency shows next to its own. Nothing to call. Set `playoutProbe: false` to send none of it. The probe needs WebAudio and `RTCRtpReceiver.getStats()`, elsewhere it sends what it can.

### Reconnection

On network hiccups the SDK reconnects automatically (`"reconnecting"` → `"connected"`). Audio resumes on its own. Events emitted during the gap are **dropped, not replayed**. A transcript may therefore skip turns lost to the outage. If recovery fails, the session ends with `disconnect` reason `"connection_lost"`.

### Ending

A session can be ended by anyone; the `disconnect` event carries who/why as an `EndReason`:

| `EndReason` | Cause |
|---|---|
| `user_hangup` | Your code called `session.end()` (or the user left the page), or your backend ended the session through the API. |
| `agent_hangup` | The agent ended the call: a hang-up decision, or the workflow reaching an end node. |
| `conversation_timeout` | The session hit its duration limit (`max_duration_seconds`). |
| `escalated` | The call was handed off to a human agent. |
| `llm_endpoint_failure` | The agent's custom LLM endpoint failed repeatedly and the runtime closed the call. |
| `connection_lost` | Reconnection failed, the agent never joined (15 s), or the call dropped before the server could say why. |

Reasons other than `connection_lost` are announced by the server over the protocol's `session.ended` event just before it tears the call down; the values match the session record your backend reads (`endReason`), so both sides reconcile exactly. Against an older runtime that never announces, every server-side end surfaces as `agent_hangup` (inferred from the room closing).

`session.end()` is idempotent, including concurrent calls while teardown is still in flight, and `endReason` stays readable on the ended session.

## Transports

The public API is transport-neutral. The server picks the transport when creating the session, and the session token carries it. Today that is WebRTC (`"livekit"`). If a future server issues a transport your SDK version does not know, `start()` fails fast with `unsupported_transport` instead of degrading silently. Pin your upgrade path on that code.

The one deliberate exception is `session.getRoom()`. It returns the live [livekit-client `Room`](https://docs.livekit.io/reference/client-sdk-js/) for needs the session API does not cover yet, such as connection-quality telemetry or publishing extra tracks. Prefer the session API where one exists. Device switching, for example, is covered by `setInputDevice` and `setOutputDevice`. Code built on the `Room` couples to this SDK's transport choice and its pinned livekit-client major, with no compatibility promise across SDK versions. `getRoom()` returns `undefined` once the session has ended.
