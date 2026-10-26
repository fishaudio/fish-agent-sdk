---
"@fishaudio/agent-protocol": minor
"@fishaudio/agent-client": minor
---

The protocol catches up with what the runtime already sends. `tool.failed` gains an optional `httpStatus`, the HTTP status a tool's endpoint answered with when the call still failed (a 3xx/4xx/5xx from a webhook tool, or a response a built-in integration tool could not use). `error` gains `stage` (`llm`, `stt`, `tts` or `runtime`) and `recovered` (true when the runtime is still going to answer the turn by itself, false when the turn is lost). `session.ended` gains the reason `llm_endpoint_failure`, sent when the agent's custom LLM endpoint failed repeatedly and the runtime closed the session. The participant attributes `fish.agent.ready` and `fish.client.audio_ready` are published as the constants `AGENT_READY_ATTRIBUTE`, `CLIENT_AUDIO_READY_ATTRIBUTE` and `CLIENT_AUDIO_READY_PENDING`, so clients and the runtime share one definition. `AgentSessionCreateRequest` gains `llm_extra_body` and `record_audio`, both meant for your backend's session-creation call (the SDK's public-agent options do not expose them).

On the client, `FishAgentError` gains optional `stage` and `recovered` for in-call `provider_error` / `internal_error` events, so a retry the agent handles itself can be shown as a light hint instead of a failure. The `toolCallFailed` event forwards `httpStatus`. `EndReason` gains `llm_endpoint_failure`, matching the new `session.ended` reason.
