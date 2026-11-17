---
"@fishaudio/agent-client": minor
---

New experimental `origin` option for public agents outside a browser (it may change or be removed in a minor release). Native apps (React Native) and Node send no `Origin` header. That is fine for most public agents, which take any origin, but an agent that restricts origins refuses such a request with `origin_forbidden`; `AgentSession.start({ agentId, origin })` presents one of its allowed origins. Browsers ignore it. An `origin_forbidden` outside a browser without `origin` now says to pass one.
