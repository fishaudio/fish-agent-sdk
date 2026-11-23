---
"@fishaudio/agent-widget": patch
---

A client tool failure (`tool_failed`, `tool_timeout`) no longer shows the "Connection failed" banner. The call keeps running and the agent hears the error as the tool's result. The `fish-agent:error` event still reports it.
