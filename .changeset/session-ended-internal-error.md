---
"@fishaudio/agent-protocol": minor
"@fishaudio/agent-client": minor
---

`session.ended` gains the reason `internal_error`: the runtime itself failed and closed the session, for example its process was stopped for exceeding its memory limit. Until now such an end reached clients only as a transport disconnect, which the SDK reported as `connection_lost`. `EndReason` on the client gains the same value, matching `end_reason: internal_error` on the session record.
