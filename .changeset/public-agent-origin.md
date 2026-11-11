---
"@fishaudio/agent-client": minor
---

New experimental `origin` option for public agents outside a browser (it may change or be removed in a minor release). Native apps (React Native) and Node send no `Origin` header, so a keyless session was always refused with `origin_forbidden`; `AgentSession.start({ agentId, origin })` now presents an origin from the agent's allowlist. Browsers ignore it. A missing origin outside a browser now says to pass one.
