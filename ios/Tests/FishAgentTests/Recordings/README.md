# LiveKit event recordings (iOS)

Real event sequences from LiveKit's Swift SDK 2.19.0, recorded on 2026-11-21 against a production agent. They are the input for the transport tests: the fake room used in those tests replays these sequences, so the tests check our logic against what LiveKit actually does on iOS, not against what we assumed.

**Recorded on a simulator** (iPhone 16, iOS 18.5). Calls through the finished SDK were later checked on an iPhone 12 (see `examples/ios/README.md`), but these sequences were not recorded again there. Two things differ on the phone: `disconnect` returns in about 0.3 seconds, not 2.6, and the audio session is in video-chat or voice-chat mode, not `default`.

## How they were made

A throwaway app joined a session through the SDK's own `LiveKitRoomAdapter`, following the join order in `docs/protocol.md`, and printed every fact the adapter reported and each of its own actions as one JSON line. The app is not in the repository.

Each line has:

| Field | Meaning |
|---|---|
| `n` | Sequence number. |
| `t` | Milliseconds since the app started. |
| `call` | Which call of the app run (only `two-calls` has a second). |
| `e` | A fact from the adapter (`Connected`, `ParticipantDisconnected`, `AttributesChanged`, `AudioTrackSubscribed`, `DataReceived`, `stream.open`, `stream.chunk`, `stream.close`, …) or a probe action (`connect.begin`, `connect.returned`, `attr.pending.done`, `sent`, `cmd`, `audio.session.*`). |
| `roomState` | The room's state read when the line was logged. |
| `remotes` | The number of remote participants read when the line was logged. |

The `audio.session.*` and `mic.enabled` lines also carry the `AVAudioSession` category, mode, option bits and current route. The agent worker's name and job IDs are removed.

## Scenarios

| File | What happens |
|---|---|
| `local-hangup.jsonl` | The app sends `user.hangup`, then disconnects. |
| `server-end.jsonl` | The backend calls `POST /v1/agent/sessions/{id}/end`. |
| `agent-hangup.jsonl` | The agent hangs up after the user stays silent. |
| `pending-before-connect.jsonl` | `fish.client.audio_ready = "pending"` is set as soon as `connect` returns. No ready report is sent. |
| `two-calls.jsonl` | Two calls in one app run, each ended by the app. |

## What they show

Where iOS differs from the browser SDK that `packages/client/src/transport/livekit.ts` is written for, and from Android (see `android/agent/src/test/resources/livekit-recordings/README.md`).

1. **`connect` returns with the room already connected.** Android returns while still connecting.
2. **Setting an attribute waits for the server's answer** and the local participant then reports the change. `"pending"` set right after `connect` returns is accepted (`pending-before-connect.jsonl`). On Android an attribute set that early is dropped.
3. **A participant leaving is reported while the room still reads `connected` and still counts the participant.** In `agent-hangup.jsonl`, `ParticipantDisconnected` arrives with `roomState` `connected` and `remotes` 1; `Disconnected` follows one millisecond later. Nothing can be decided when the event arrives. The transport waits a moment and then looks at the room.
4. **A departing participant's attributes are reported once more with empty values** (`"fish.agent.ready": ""`, `"lk.agent.state": ""`), and so are the local ones. An empty value has to be treated as no value.
5. **Attribute changes carry only what changed.** A participant that joins is reported with an attribute change first and the join second.
6. **`disconnect` takes about 2.6 seconds to return** on the simulator (`local-hangup.jsonl`, between `sent` and `disconnect.returned`). A call the user ends is only reported as ended after that.
7. **A backend-forced end can arrive without `session.ended`.** In `server-end.jsonl` only `Disconnected` with `ROOM_DELETED` arrives. The same action on Android did deliver `session.ended`. Without it the end reads as `agent_hangup`.
8. **LiveKit configures the audio session by itself.** During a call it is `playAndRecord`, mode `default`, with Bluetooth, AirPlay and default-to-speaker options, routed to the speaker. After the call the category stays `playAndRecord` (`two-calls.jsonl`, `audio.session.between` and `audio.session.after`). The SDK sets it back when the call ends.
9. **The second call of an app run connects and publishes the microphone like the first** (`two-calls.jsonl`). Whether the microphone actually captures on a second call can only be heard on a phone.

## Not recorded

- Any of this on a physical iPhone.
- Network outages and reconnects. The simulator shares the Mac's network, so an outage cannot be made for it alone. The transport's reconnect rules are tested with the sequences recorded on Android.
- An agent that leaves while the room stays open (older runtimes).
