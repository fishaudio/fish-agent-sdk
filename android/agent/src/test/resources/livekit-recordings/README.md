# LiveKit event recordings (Android)

Real event sequences from `io.livekit:livekit-android` 2.30.0, recorded on 2026-11-21 against a production agent. They are the input for the transport tests: the fake room used in those tests replays these sequences, so the tests check our logic against what LiveKit actually does on Android, not against what we assumed.

**Recorded on an emulator** (Android 16, API 36, arm64). Calls through the finished SDK were later checked on a Pixel 8, including 12 and 40 second outages (see `examples/android/README.md`); the SDK behaved the same there. These sequences were not recorded again on the phone.

## How they were made

A throwaway app joined a session with the bare LiveKit SDK, following the join order in `docs/protocol.md`, and logged every `RoomEvent`, every `lk.transcription` text stream callback and each of its own actions as one JSON line. The app is not in the repository.

Each line has:

| Field | Meaning |
|---|---|
| `n` | Sequence number. |
| `t` | Milliseconds since the app started. |
| `e` | A `RoomEvent` class name (`Reconnecting`, `ParticipantDisconnected`, …), a text stream callback (`stream.open`, `stream.chunk`, `stream.close`, `stream.error`), or a probe action (`connect.begin`, `connect.returned`, `attr.pending.sent`, `attr.ready.sent`, `sent`, `cmd`). |
| `roomState` | `Room.state` read when the line was logged. |
| `remotes` | `Room.remoteParticipants.size` read when the line was logged. |
| `thread` | `main` or `background`: the thread the callback ran on. |

Session IDs, participant identities and the agent worker's name are replaced or removed. `TranscriptionReceived` events (LiveKit's older transcript API, a duplicate of the text streams) are left out.

## Scenarios

| File | What happens |
|---|---|
| `local-hangup.jsonl` | The app sends `user.hangup`, then disconnects. |
| `server-end.jsonl` | The backend calls `POST /v1/agent/sessions/{id}/end`. |
| `agent-hangup.jsonl` | The agent hangs up after the user stays silent. |
| `network-off-3s.jsonl` | Airplane mode on for 3 s, then off. |
| `network-off-12s.jsonl` | Airplane mode on for 12 s, then off. |
| `network-off-40s.jsonl` | Airplane mode on for 40 s, then off. The agent then hangs up for silence. |
| `pending-set-before-connected.jsonl` | `fish.client.audio_ready = "pending"` set as soon as `connect()` returns. No ready report is sent. |
| `pending-set-after-connected.jsonl` | The same, set after the room reports `CONNECTED`. |

## What they show

These are the places where Android differs from the browser SDK that `packages/client/src/transport/livekit.ts` is written for.

1. **`Room.connect()` returns while the room is still `CONNECTING`.** The `Connected` event arrives 300–500 ms later.
2. **An attribute set before `CONNECTED` is dropped without an error.** In `pending-set-before-connected.jsonl` the local participant never gets an attribute change for `"pending"`. In `pending-set-after-connected.jsonl` it arrives about 100 ms after the call. The transport has to wait for `CONNECTED` before it sets `fish.client.audio_ready`.
3. **A network drop goes straight to a full reconnect.** There is one `Reconnecting` event and the state becomes `RECONNECTING`. Android has no separate signal-resume event. All three outages recovered, including the 40 s one.
4. **The roster is cleared during a reconnect.** `ParticipantDisconnected` for the agent arrives with `roomState` `RECONNECTING` and `remotes` 0. It must not be read as the agent leaving. The agent has only left when this event arrives while the room is `CONNECTED`.
5. **`Reconnected` can arrive before the agent is back in the roster.** After the 3 s and 12 s outages `ParticipantConnected` came first. After the 40 s outage `Reconnected` came first, with `remotes` 0, and `ParticipantConnected` followed 41 ms later. The rule "no remote participant after `Reconnected` means the agent hung up" would have ended a live call. The transport has to wait a moment for the roster before deciding.
6. **Our own reliable packets come back after a reconnect.** `client.audio_ready` is delivered to us as `DataReceived` with topic `client-event` and no sender. Only topic `agent-event` may be handled.
7. **The local attribute survives a reconnect on the local participant object** (`Reconnected` shows `fish.client.audio_ready` still set). Whether the server kept it is not visible from the client, so it is set again after `Reconnected`, as `docs/protocol.md` says.
8. **Ends announced by the runtime arrive as `session.ended`, then `Disconnected` with `ROOM_DELETED`.** The agent's `ParticipantDisconnected` arrives after the room state is already `DISCONNECTED`.
9. **A local `disconnect()` also fires `ParticipantDisconnected`** for the agent, with the room `DISCONNECTED`, before `Disconnected(CLIENT_INITIATED)`.
10. **Text stream handlers are called on a background thread**; `RoomEvent`s collected from the main scope arrive on the main thread. Order between the two is only kept if both are funnelled through one queue.
11. **The agent publishes two audio tracks.** Speech has source `MICROPHONE`. The second has source `UNKNOWN`. Only the first counts as the agent's voice.
12. **Agent text arrives as deltas** (append them). A typed reply (`audio: false`) arrives as many small chunks within a few milliseconds.

## For the runtime team

Two things seen here are on the server side:

- An end forced through the backend API is announced as `session.ended` with reason `user_hangup` (`server-end.jsonl`).
- After the 40 s outage the agent hung up for silence and the room was deleted, but no `session.ended` reached the client (`network-off-40s.jsonl`). The same hang-up without an outage does announce `agent_hangup` (`agent-hangup.jsonl`). The client then falls back to `agent_hangup` from `ROOM_DELETED`, which happens to be right here.

## Building against LiveKit

`livekit-android` depends on `com.github.davidliu:audioswitch`, which is only published on JitPack. An app that uses LiveKit, and so any app that uses this SDK, needs `maven("https://jitpack.io")` in its repositories.

## Not recorded

- Any of this on a physical phone.
- A signal-only resume (for example Wi-Fi to cellular handover). Airplane mode never produced one.
- An agent that leaves while the room stays open (older runtimes). Every end here deleted the room.
