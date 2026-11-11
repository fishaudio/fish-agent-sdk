# Writing a client for the realtime protocol

This page is for building a client without `@fishaudio/agent-client`: a native app, a React Native app that does not use the SDK, or another language. It spells out the behavior the SDK implements on top of the types in [`@fishaudio/agent-protocol`](../packages/protocol/README.md), so you can match it without reading the SDK source.

If you are on the web or React Native, use the SDK instead. It already does all of this.

The transport today is LiveKit (WebRTC). Media goes over audio tracks, control messages over data packets on two topics, readiness over participant attributes, and transcripts over LiveKit text streams.

## 1. Get a session token

`POST /v1/agent/sessions` returns a `SessionToken`. Check `transport` first: if it is not a value you support, fail with an explicit "please upgrade" error. Never try to guess.

- **Mobile and desktop apps:** get the token from your own backend, which calls the endpoint with your API key. Do not ship an API key in an app.
- **Public agents** (keyless) are meant for browsers. The server checks the request's `Origin` header against the agent's allowlist. A browser sets that header and pages cannot change it. Other clients can send any value, so the check limits which websites can embed the agent. It does not authenticate the caller. Do not rely on public mode for native apps.

`expires_at` is the deadline to join, not the length of the call. `max_duration_seconds` caps the call itself. The runtime ends the call when it reaches the cap.

## 2. Join

Do these steps in this order:

```text
client                                   room / agent
  │ room.connect(livekit_url, token) ───────▶│
  │ set attribute fish.client.audio_ready = "pending"   (right away, before any other await)
  │ read attributes of participants already in the room  (they are sticky, no change event fires)
  │ publish microphone track ───────────────▶│
  │                                          │ agent sets lk.agent.state = "listening" …
  │                                          │ agent sets fish.agent.ready = <epoch ms>
  │◀──────────── agent audio track subscribed│
  │ set attribute fish.client.audio_ready = <epoch ms>
  │ send {type:"client.audio_ready", at} on client-event
  │◀──────────────────────────── opening line│
```

**Audio readiness.** Announce `"pending"` as soon as the room connects. That tells the runtime to hold its opening line until you report. Report the ready value once the agent's audio can actually be heard:
- In a browser, report when `play()` on the agent's speech track resolves. Autoplay rules can block playback until then.
- With native WebRTC (iOS, Android, React Native), playback has no autoplay gate. Report when the agent's microphone-source track is subscribed.

Send the ready value both as the attribute and as a `client.audio_ready` message. LiveKit delays attribute updates from a participant with no published track for several seconds; the data message arrives at once. Report only once. The runtime's wait is bounded, so a report that never arrives only delays the opening line.

Setting attributes requires a join token that allows it. Treat a failed `setAttributes` as non-fatal, and catch its rejection.

## 3. Wait for the agent before sending

Data packets reach only participants already in the room, and the agent registers its handlers while it starts up. A message sent too early is lost. Queue `user.message` (and anything else you send) until the agent is ready, then send the queue in order.

- **Ready:** the agent participant has `fish.agent.ready` set (epoch ms). Treat this as the only ready signal.
- **`lk.agent.state` alone is not ready.** The agent framework sets it 2–4 seconds before `fish.agent.ready`. It proves the agent joined. Older runtimes never set `fish.agent.ready`, so if you see a state and no ready signal for **8 seconds**, treat the agent as ready.
- **Join timeout:** if no agent participant shows up within **15 seconds** of connecting, end the session as `connection_lost` and tell the user.

`lk.agent.state` values are `initializing`, `listening`, `thinking`, `speaking`. They are reliable for showing the agent's state in the UI.

## 4. Messages

Every data packet carries one complete JSON object with a `type`. Ignore unknown `type` values and unknown fields; the protocol only adds things.

Agent → client on topic `agent-event` (`AgentSessionMessage`):

| `type` | What to do |
|---|---|
| `client_tool.call` | Run the named tool with `params`. If `expectsResponse` is true, reply with `client_tool.result` carrying the same `callId`. Time out after `timeoutMs` when it is present (the SDK answers slightly earlier, so its error result arrives before the agent gives up); older runtimes omit it, and the SDK then uses 15 s. |
| `tool.started` / `tool.completed` / `tool.failed` | Show tool activity. One start and one end per `callId`. End messages repeat the name and source, so you can render them even if you missed the start. `nodeId` is always present (it can be an empty string). Sent only when the session was created with `tool_events` (the default is true). |
| `session.ended` | The runtime is about to close the call. Keep `reason`; it is the authoritative end reason (see section 7). |
| `error` | A pipeline stage failed. `recovered: true` means the runtime will still answer this turn, so a light "retrying" hint is enough. It never means the session ended. |

Client → agent on topic `client-event` (`ClientSessionMessage`), all sent reliable:

| `type` | When |
|---|---|
| `user.message` | Typed text. `audio: false` asks for a text-only reply. There is no echo; show the user's message yourself. |
| `user.activity` | The user is typing or otherwise active, so the agent does not treat silence as idle. |
| `user.interrupt` | Stop the agent's current reply. |
| `user.hangup` | End the call. Send it, then leave the room. |
| `client.audio_ready` | See section 2. |
| `client_tool.result` | The result of a `client_tool.call`. Keep the serialized message under about **60 KB**; the data channel rejects larger packets. If a result is too large or cannot be serialized, send `isError: true` with a short reason instead, so the agent does not wait out its timeout. |

## 5. Transcripts

Both sides' transcripts arrive on LiveKit text streams with topic `lk.transcription`. They are not part of `agent-event`.

- Group by the stream attribute `lk.segment_id`. Ignore streams without one.
- The sender's identity tells the role. If it is your own identity, the text is the user's speech recognized on the agent's side; otherwise it is the agent.
- **Agent segments** stream as deltas that follow playback. Append each chunk. The segment is final when the stream closes. If the reply is interrupted, the stream closes with only the spoken part.
- **User segments** are sent again in full on every update. Replace, don't append. A segment is final when `lk.transcription_final` is `"true"` and the stream was not aborted.
- Treat an open agent segment as "speaking" only as a hint: fixed opening lines can arrive all at once, well before they finish playing. `lk.agent.state` is the more accurate signal.

## 6. Reconnection

LiveKit recovers from network drops on its own, in two ways:
- **Signal resume** (short drops): `SignalReconnecting`, then `Reconnected`.
- **Full reconnect:** `Reconnecting`, then `Reconnected`. This also creates a new local participant.

Show "reconnecting" for **both** events; nothing flows in between. After `Reconnected`:
- Set `fish.client.audio_ready` again with the same value as before (or `"pending"` if you never reported ready). A full reconnect drops your attributes.
- If no remote participant is in the room, the agent hung up while you were away. End the session.
- Otherwise read the agent's attributes again.

Messages and transcript chunks sent during the gap are lost, not replayed.

## 7. Ending

The call ends in one of these ways, in order of priority:

1. **You hung up:** the end reason is `user_hangup`.
2. **The runtime announced `session.ended`:** use its `reason`. The room usually closes right after. If it does not close within **10 seconds**, end locally with that reason.
3. **No announcement:**
   - The agent participant left while the room is still connected (wait one tick; a full reconnect also clears the roster), or the room was disconnected with `ROOM_DELETED` or `ROOM_CLOSED`: end as `agent_hangup`.
   - Anything else: `connection_lost`.

Case 3 is a guess. A runtime crash, a network failure, and some server-side ends look the same from the client.

## Known gaps

These are open on the runtime side. Clients cannot fix them yet:

- There is no signal that media is flowing both ways. A client can be "connected" and have an agent that is "ready" while the audio path never came up. Consider showing "connecting audio…" until the agent's audio track is subscribed.
- `client_tool.call` carries `timeoutMs` only on newer runtimes.
