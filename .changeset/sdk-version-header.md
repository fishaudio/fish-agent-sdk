---
"@fishaudio/agent-client": patch
---

The `X-Fish-SDK` header sent when the SDK creates a public session now carries the real package version (`agent-client/<version>`). Every release so far reported `agent-client/0.0.1`. The version is read from the package manifest at build time, so it cannot drift again.
