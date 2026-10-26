# Events

Subscribe with `session.on(event, listener)`, `off`, and `once`, or pass `callbacks` at start. Each `onXxx` key subscribes the `xxx` event, so `onUserTranscript` subscribes `userTranscript`. An unknown key makes `start()` throw a `TypeError`.

| Event | Payload | Fired when |
|---|---|---|
| `connect` | `{ sessionId }` | The realtime session is established. |
| `disconnect` | `{ reason: EndReason }` | The session ended, by anyone. Terminal. |
| `statusChange` | `SessionStatus` | `"connecting" → "connected" ⇄ "reconnecting" → "ended"` |
| `modeChange` | `AgentMode` | `"listening" \| "thinking" \| "speaking"`. Drives a talking-orb UI. |
| `userTranscript` | `{ segmentId, text, final }` | Live transcription of the user. |
| `agentResponseDelta` | `{ segmentId, delta, text }` | Streaming agent speech text (playout-synced). |
| `agentResponse` | `{ segmentId, text }` | Agent speech segment finalized. |
| `message` | `{ role, text }` | Finalized messages only, in order. A ready-made chat log. |
| `toolCallStarted` | `{ callId, toolName, source, input, inputTruncated }` | The agent started running a tool. |
| `toolCallCompleted` | `{ callId, toolName, source, output, outputTruncated }` | The tool returned a result. |
| `toolCallFailed` | `{ callId, toolName, source, error, httpStatus? }` | The tool errored. `httpStatus` is set when the tool's HTTP endpoint answered and the call still failed, see [Tool call lifecycle](#tool-call-lifecycle). |
| `error` | `FishAgentError` | A recoverable error occurred (the session may still be live). For `provider_error` / `internal_error`, `error.recovered` says whether the runtime is retrying the turn itself. See [Errors](errors.md#in-call-errors). |

## Live transcripts

Both transcript streams send the **whole segment so far**. Replace the segment's text on each event. Do not append.

- `userTranscript` may reword earlier text as interim recognition improves. `final: true` pins the segment. `segmentId` identifies which segment to update.
- `agentResponseDelta` carries `delta`, the new fragment, and `text`, the accumulated segment. `agentResponse` fires once when the segment completes. Agent text is paced with audio playout, so an interrupted reply finalizes with only what was actually spoken. A reply that spans multiple speech segments, for example around a tool call, arrives as multiple segments.

If you only need finalized messages in order (no streaming updates), subscribe to `message` instead. In React, [`useAgentMessages`](react/useAgentMessages.md) does this aggregation for you.

A listener attached late misses events fired before it subscribed. To backfill, call `session.getTranscript()`. It returns every segment so far as `{ segmentId, role, text, final }` in conversation order. Then keep applying live events by `segmentId`.

## Tool call lifecycle

Every tool the agent runs emits one `toolCallStarted`. That covers webhook, MCP, built-in, and [client tools](client-tools.md). Exactly one `toolCallCompleted` or `toolCallFailed` with the same `callId` resolves it. Terminal events repeat `toolName` and `source`, so a listener attached mid-call can still render a complete item. `input` and `output` are JSON strings truncated at 4 KB. Parse them only when the matching `*Truncated` flag is `false`.

`httpStatus` on `toolCallFailed` is the HTTP status the tool's endpoint answered with when the call failed after a response arrived: a 3xx, 4xx or 5xx from a webhook tool, or a response a built-in integration tool could not use. The field is absent when no response arrived (timeout, DNS failure) and for client and MCP tools. `error` stays a short generic text when the agent is configured to hide tool errors, the status code travels separately.

These events stream by default, and they carry tool arguments and results into the end user's browser. To keep tool data hidden, create the session with `toolEvents: false` for a public agent, or with `tool_events: false` on your backend's session-creation call. See [Sessions](sessions.md).

## Delivery notes

- Events emitted during a [reconnection](sessions.md#reconnection) gap are dropped, not replayed. A transcript may skip turns lost to the outage.
- Unknown server events are ignored by design. Old SDK versions keep working as the protocol grows.
