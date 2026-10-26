# @fishaudio/agent-client

## 0.4.0

### Minor Changes

- 1e263f5: Sessions now report playback readiness to the agent. Right after joining, the SDK announces that it will report when it can play audio, and once the agent's audio track is attached and the browser has allowed playback it reports ready. Where the runtime supports this handshake, the agent holds its opening line until then (bounded, about 1.5 seconds), so the first words are not lost on iOS, during a Bluetooth route switch, or while playback is still unlocking. Elsewhere the opening line plays right away, as before. Nothing to call. The ready report goes out both as a participant attribute and as a `client.audio_ready` frame on the client-event topic, so a session without a microphone (no published track, where LiveKit delays attribute updates) gets the same handshake. Under an autoplay block the report goes out when `session.startAudio()` unlocks playback, so keep calling it from a user gesture when playback was blocked.

  The agent's ready signal (its pipeline is live and the opening line is queued) is now the primary "agent joined" signal for the 15 s join watchdog and for releasing messages typed before the agent arrived. The agent's framework state stays as the fallback, so older runtimes behave as before.

- 1e263f5: The protocol catches up with what the runtime already sends. `tool.failed` gains an optional `httpStatus`, the HTTP status a tool's endpoint answered with when the call still failed (a 3xx/4xx/5xx from a webhook tool, or a response a built-in integration tool could not use). `error` gains `stage` (`llm`, `stt`, `tts` or `runtime`) and `recovered` (true when the runtime is still going to answer the turn by itself, false when the turn is lost). `session.ended` gains the reason `llm_endpoint_failure`, sent when the agent's custom LLM endpoint failed repeatedly and the runtime closed the session. The participant attributes `fish.agent.ready` and `fish.client.audio_ready` are published as the constants `AGENT_READY_ATTRIBUTE`, `CLIENT_AUDIO_READY_ATTRIBUTE` and `CLIENT_AUDIO_READY_PENDING`, so clients and the runtime share one definition. `ClientSessionMessage` gains `client.audio_ready`, the ready report's copy on the client-event topic. `AgentSessionCreateRequest` gains `llm_extra_body` and `record_audio`, both meant for your backend's session-creation call (the SDK's public-agent options do not expose them).

  On the client, `FishAgentError` gains optional `stage` and `recovered` for in-call `provider_error` / `internal_error` events, so a retry the agent handles itself can be shown as a light hint instead of a failure. The `toolCallFailed` event forwards `httpStatus`. `EndReason` gains `llm_endpoint_failure`, matching the new `session.ended` reason.

- 6759dc7: Session creation gains `context` (`SessionContext`), the per-session overrides of the agent's context switches, with `context.current_time` for the current date and time. The client option is `context: { currentTime }`. `world_context` / `worldContext` stay accepted as deprecated aliases.

### Patch Changes

- e2751b1: The `X-Fish-SDK` header sent when the SDK creates a public session now carries the real package version (`agent-client/<version>`). Every release so far reported `agent-client/0.0.1`. The version is read from the package manifest at build time, so it cannot drift again.
- Updated dependencies [1e263f5]
- Updated dependencies [6759dc7]
- Updated dependencies [79f881d]
  - @fishaudio/agent-protocol@0.4.0

## 0.3.0

### Minor Changes

- 4e2d043: Sessions now end with the reason the server announces instead of one inferred from the disconnect. The protocol gains a `session.ended` message on the agent-event topic, sent just before the server tears the call down, and `EndReason` grows `conversation_timeout` (the session hit its duration limit) and `escalated` (the call was handed off to a human). Previously every server-side end, including the duration limit and a backend-initiated end, surfaced as `agent_hangup`. A backend-initiated end now reports `user_hangup` when that is the reason the server records. Against a server that does not announce, the disconnect-based inference still applies.

### Patch Changes

- Updated dependencies [4e2d043]
- Updated dependencies [c64b6b1]
- Updated dependencies
- Updated dependencies [d69af1f]
  - @fishaudio/agent-protocol@0.3.0

## 0.2.1

### Patch Changes

- 98ceef5: `AgentSession.start()` now throws a `TypeError` for unknown `callbacks` keys (for example a bare event name such as `userTranscript` instead of `onUserTranscript`) and for values that are not functions. Previously such entries were silently subscribed to a non-existent event and never fired. The check runs before the microphone prompt or any server request.
- e258acc: Client tool results that cannot be delivered no longer leave the agent waiting on its server-side tool timeout. A result larger than about 60 KB serialized (`MAX_CLIENT_TOOL_RESULT_BYTES`), a non-JSON-serializable value, or a transport error on send is replaced by an error result that tells the agent what happened, alongside the existing `tool_failed` error event.
- b05db7d: Republish with resolved internal dependency ranges. The 0.2.0 tarballs declared their `@fishaudio/*` dependencies with the `workspace:^` protocol, which npm cannot install; packing and publishing now go through pnpm only, and a release-time check verifies the packed manifests.
- Updated dependencies [b05db7d]
  - @fishaudio/agent-protocol@0.2.1

## 0.2.0

### Minor Changes

- d64ffb4: Typed turns now default to a text-only reply. `sendUserMessage(text)` sends `audio: false` unless called with `{ audio: true }`, so the agent answers typed input as streaming transcript text without synthesizing speech. Previously the default was a spoken reply and `{ audio: false }` was the opt-out. The widget follows the new default: typed messages in the widget also get a text-only reply. The wire protocol is unchanged — an absent `audio` field still means a spoken reply for raw-protocol clients.

### Patch Changes

- 80d5489: Start microphone capture inside the user gesture that calls `AgentSession.start`. Previously getUserMedia ran only after the session-token exchange and the realtime connect, and browsers that gate the permission prompt on the gesture's transient activation (Safari, in-app WebViews) rejected it without ever prompting — every start then failed with `mic_permission_denied` on those devices. A denied microphone now also rejects before the realtime session connects, and a capture that never got published is released on teardown.
  - @fishaudio/agent-protocol@0.2.0

## 0.1.0

### Minor Changes

- Revise `SessionOverrides`: rename `voice_profile_id` to `voice_id`, add `first_message_prompt` (mutually exclusive with `first_message`), and move the language override fully into `overrides.language` — the top-level `language` request field is gone. The `language` start option still works and now folds into overrides client-side; an explicit `overrides.language` wins. Keyless (public) session creation accepts only the `language` and `voice_id` overrides.

### Patch Changes

- Updated dependencies
  - @fishaudio/agent-protocol@0.1.0
