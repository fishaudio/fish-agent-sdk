# @fishaudio/agent-protocol

## 0.4.1

## 0.4.0

### Minor Changes

- 1e263f5: The protocol catches up with what the runtime already sends. `tool.failed` gains an optional `httpStatus`, the HTTP status a tool's endpoint answered with when the call still failed (a 3xx/4xx/5xx from a webhook tool, or a response a built-in integration tool could not use). `error` gains `stage` (`llm`, `stt`, `tts` or `runtime`) and `recovered` (true when the runtime is still going to answer the turn by itself, false when the turn is lost). `session.ended` gains the reason `llm_endpoint_failure`, sent when the agent's custom LLM endpoint failed repeatedly and the runtime closed the session. The participant attributes `fish.agent.ready` and `fish.client.audio_ready` are published as the constants `AGENT_READY_ATTRIBUTE`, `CLIENT_AUDIO_READY_ATTRIBUTE` and `CLIENT_AUDIO_READY_PENDING`, so clients and the runtime share one definition. `ClientSessionMessage` gains `client.audio_ready`, the ready report's copy on the client-event topic. `AgentSessionCreateRequest` gains `llm_extra_body` and `record_audio`, both meant for your backend's session-creation call (the SDK's public-agent options do not expose them).

  On the client, `FishAgentError` gains optional `stage` and `recovered` for in-call `provider_error` / `internal_error` events, so a retry the agent handles itself can be shown as a light hint instead of a failure. The `toolCallFailed` event forwards `httpStatus`. `EndReason` gains `llm_endpoint_failure`, matching the new `session.ended` reason.

- 6759dc7: Session creation gains `context` (`SessionContext`), the per-session overrides of the agent's context switches, with `context.current_time` for the current date and time. The client option is `context: { currentTime }`. `world_context` / `worldContext` stay accepted as deprecated aliases.
- 79f881d: `SessionOverrides` gains `asr` (`SessionAsrOverrides`), nested like the agent's `asr` configuration. `asr.model` picks the speech recognition model for one session. Only API-key session creation accepts it.

## 0.3.0

### Minor Changes

- 4e2d043: Sessions now end with the reason the server announces instead of one inferred from the disconnect. The protocol gains a `session.ended` message on the agent-event topic, sent just before the server tears the call down, and `EndReason` grows `conversation_timeout` (the session hit its duration limit) and `escalated` (the call was handed off to a human). Previously every server-side end, including the duration limit and a backend-initiated end, surfaced as `agent_hangup`. A backend-initiated end now reports `user_hangup` when that is the reason the server records. Against a server that does not announce, the disconnect-based inference still applies.
- c64b6b1: `SessionLanguage` accepts `ar`, `hi`, `id`, and `tr` (Arabic, Hindi, Indonesian, Turkish) for the `language` option and `overrides.language`.
- `SessionLanguage` accepts `pt`, `it`, and `nl` (Portuguese, Italian, Dutch) for the `language` option and `overrides.language`. The 0.2.1 release shipped only `en`, `ja`, `zh`, `ko`, `es`, `fr`, and `de`.
- d69af1f: `SessionLanguage` grows to 52 codes: `ru`, `bg`, `sr`, `hr`, `cs`, `sk`, `pl`, `uk`, `ro`, `hu`, `el`, `sv`, `da`, `no`, `fi`, `et`, `lv`, `lt`, `ca`, `he`, `fa`, `ur`, `kk`, `ka`, `hy`, `bn`, `ta`, `te`, `kn`, `mr`, `gu`, `pa`, `ne`, `th`, `vi`, `ms`, `tl`, `af` join the set.

## 0.2.1

### Patch Changes

- b05db7d: Republish with resolved internal dependency ranges. The 0.2.0 tarballs declared their `@fishaudio/*` dependencies with the `workspace:^` protocol, which npm cannot install; packing and publishing now go through pnpm only, and a release-time check verifies the packed manifests.

## 0.2.0

## 0.1.0

### Minor Changes

- Revise `SessionOverrides`: rename `voice_profile_id` to `voice_id`, add `first_message_prompt` (mutually exclusive with `first_message`), and move the language override fully into `overrides.language` — the top-level `language` request field is gone. The `language` start option still works and now folds into overrides client-side; an explicit `overrides.language` wins. Keyless (public) session creation accepts only the `language` and `voice_id` overrides.
