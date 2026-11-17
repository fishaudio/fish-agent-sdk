---
"@fishaudio/agent-client": patch
---

Docs and hints for public agents follow the platform's new default: a public agent takes any origin unless it restricts origins, so apps connect with just `agentId`. `origin` is only needed for an agent that restricts origins, and the `origin_forbidden` hint outside a browser now says so.
