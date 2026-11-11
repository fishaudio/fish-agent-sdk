---
"@fishaudio/agent-client": patch
---

A client tool now times out slightly before the agent's own deadline (the smaller of 1 s and 10 % earlier) when the runtime sends `timeoutMs`, so the agent receives the error result instead of giving up first.
