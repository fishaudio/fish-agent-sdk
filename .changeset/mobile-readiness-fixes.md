---
"@fishaudio/agent-client": patch
---

Fixes found while running the SDK on mobile:

- A short network drop that LiveKit recovers with a signal-only resume now shows `reconnecting`. Before, the status stayed `connected` while nothing went through.
- Typed messages sent before the agent is ready now wait for its ready signal. The agent's framework state, which arrives seconds earlier, no longer releases them. Runtimes without the ready signal get it after 8 s.
- A client tool now times out when the agent stops waiting for it, if the runtime says how long that is. Otherwise `clientToolTimeoutMs` applies as before.
- Without a DOM (React Native), the session now reports audio readiness when the agent's speech track arrives. The opening line no longer waits out the runtime's limit.
