# @fishaudio/agent-protocol

The wire contract for [Fish Audio](https://fish.audio) agent sessions: the realtime room-channel messages exchanged between the agent runtime and end-user clients, and the shapes of the session-creation exchange. It contains TypeScript types and topic constants only. Zero runtime dependencies, no code.

**This is a semi-internal package.** It lives in the open so that what travels over the wire is fully auditable, and so the SDK and the agent runtime conform to one published contract. It is not an API for applications. Do not depend on it directly. [`@fishaudio/agent-client`](https://www.npmjs.com/package/@fishaudio/agent-client) already re-exports the types application code needs: `SessionToken`, `SessionOverrides`, and `AgentSessionCreateRequest`. Reach for this package only when building a custom consumer of the realtime channel or auditing the protocol itself. For that, read [Writing a client for the realtime protocol](https://github.com/fishaudio/fish-agent-sdk-web/blob/main/docs/protocol.md), which covers the behavior these types do not show: the join order, readiness, queueing, transcripts, reconnection, and end rules.

## What's inside

### Realtime channel (`realtime.ts`)

One topic constant per channel, plus the payload type that travels on it:

| Topic | Direction | Payload |
|---|---|---|
| `AGENT_EVENT_TOPIC` | agent → client | `AgentSessionMessage`. Session control such as `client_tool.call`, the `tool.started` / `tool.completed` / `tool.failed` lifecycle, `session.ended` (with a `SessionEndedReason`), and `error` (a category code plus `stage` and `recovered`). One complete JSON object per message. |
| `CLIENT_EVENT_TOPIC` | client → agent | `ClientSessionMessage`. Text injection, tool results, graceful hangup, the audio readiness report (`client.audio_ready`). |

Two participant attributes complete the room-level contract. They are published as constants so clients and the runtime share one definition:

| Constant | Set by | Meaning |
|---|---|---|
| `AGENT_READY_ATTRIBUTE` (`fish.agent.ready`) | agent | Sticky, value epoch ms. The pipeline is live and the opener is queued. Gate the "connected" UI on it. `AGENT_STATE_ATTRIBUTE` (`lk.agent.state`) arrives seconds earlier and only proves the agent joined: fall back to it only after about 8 s without the ready attribute (older runtimes never set it). |
| `CLIENT_AUDIO_READY_ATTRIBUTE` (`fish.client.audio_ready`) | client | `CLIENT_AUDIO_READY_PENDING` (`"pending"`) right after joining announces a client that will report readiness. An epoch-ms value means the agent's audio track is attached and the browser allows playback. The runtime waits a bounded time for it before speaking the opener. Publishing it needs a join token that lets the participant update its own attributes. The ready value is also sent as a `client.audio_ready` message on `CLIENT_EVENT_TOPIC`, because LiveKit delays attribute updates from a participant that has published no track (a microphone-off session). The runtime takes whichever arrives first. |

Transcripts (streaming assistant reply and user ASR, interim and final) are not part of this contract: they travel on LiveKit's built-in `lk.transcription` text streams, keyed by the `lk.segment_id` attribute, with `lk.transcription_final` marking finals and the stream's sender identity distinguishing user from agent.

### Session creation (`session.ts`)

The `POST /v1/agent/sessions` exchange:

- `AgentSessionCreateRequest` is the request body. It carries the agent id, per-session `SessionOverrides`, dynamic variables, attribution fields, and two fields meant for a backend's session-creation call rather than the SDK's public-agent options: `llm_extra_body` (forwarded to a custom LLM endpoint) and `record_audio` (per-session recording override).
- `SessionOverrides` is the allow-listed per-session config replacement. It covers first message, system prompt, voice, language, and speech recognition model.
- `SessionToken` is the response. It is a discriminated union on `transport` and is handed to the client verbatim.

## Conventions

- **Casing.** Session-creation shapes are `snake_case`, following the Fish API convention, because clients consume responses verbatim. Realtime message fields are `camelCase`.
- **Compatibility is additive-only.** Published fields never change name, meaning, or type. New fields are optional. A semantic change ships as a new `type`. Consumers must ignore unknown `type` values and unknown fields. Old clients then keep working as the protocol grows.
- **Transports.** `SessionToken.transport` is a discriminated union. A consumer that doesn't recognize the negotiated arm must fail with an explicit upgrade error, never silently.
