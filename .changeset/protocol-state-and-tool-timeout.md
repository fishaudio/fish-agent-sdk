---
"@fishaudio/agent-protocol": minor
---

Adds `AGENT_STATE_ATTRIBUTE` (`lk.agent.state`) and an optional `timeoutMs` on `client_tool.call`, the agent's wait for the result. A new guide, `docs/protocol.md`, covers what a client must do beyond the types: join order, readiness, queueing, transcripts, reconnection, and end rules.
