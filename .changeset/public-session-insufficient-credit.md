---
"@fishaudio/agent-client": minor
"@fishaudio/agent-widget": minor
---

Keyless session requests now fail with `insufficient_credit` when the agent owner's account has no Agent credit left (HTTP 402). The API used to answer with a neutral 403 that the SDK reported as `agent_not_public`, which sent integrators to re-check their public-access settings when the fix was a top-up. The widget shows the new `errorUnavailable` text ("This agent is temporarily unavailable.") for it.
