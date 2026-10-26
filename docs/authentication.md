# Authentication

Pick one of two modes:

## 1. Server-created session (recommended)

Your backend exchanges the API key for a short-lived **session token** and hands the token to the browser:

```bash
curl https://api.fish.audio/v1/agent/sessions \
  -H "Authorization: Bearer $FISH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "your-agent-id",
    "end_user_id": "user-42"
  }'
# 201 → { "session_id", "transport", "livekit_url", "token", "expires_at", ... }
```

`end_user_id` is optional. It is stored on the session record for attribution. The create body also accepts `language`, `overrides`, and `dynamic_variables` (see [Customization](customization.md)), `timezone` and `world_context` for the agent's sense of local time, free-form `metadata`, and `tool_events`. `tool_events` defaults to on. Set it to `false` to keep [tool-call arguments and results](events.md#tool-call-lifecycle) from streaming to the browser. Two more fields are not exposed through the SDK's public-agent options and belong on this backend call: `llm_extra_body`, a JSON object (at most 16 KB) forwarded verbatim to the agent's custom LLM endpoint on every request as `fishaudio_extra_body` (not stored, ignored for platform models), and `record_audio`, which overrides the agent's recording setting for this session (omit to follow the agent).

```js
// server (Node / Express)
app.post("/api/voice-session", async (req, res) => {
  const response = await fetch("https://api.fish.audio/v1/agent/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FISH_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: process.env.FISH_AGENT_ID,
      end_user_id: req.user.id,
    }),
  });
  res.status(response.status).json(await response.json());
});
```

```python
# server (Python, any framework)
import os
import requests

def create_voice_session(end_user_id: str) -> dict:
    response = requests.post(
        "https://api.fish.audio/v1/agent/sessions",
        headers={"Authorization": f"Bearer {os.environ['FISH_API_KEY']}"},
        json={
            "agent_id": os.environ["FISH_AGENT_ID"],
            "end_user_id": end_user_id,
        },
    )
    response.raise_for_status()
    return response.json()
```

```js
// browser: request the token when the user starts the call, then start with it
import { AgentSession } from "@fishaudio/agent-client";

const sessionToken = await fetch("/api/voice-session", { method: "POST" }).then((r) => r.json());
const session = await AgentSession.start({ sessionToken });
```

The session token is a discriminated union on `transport`. Forward it to the browser verbatim. The SDK validates it and connects. The token is short-lived, so fetch it in the same click handler that calls `start()`, not at page load. To force-end a session from your backend, call `POST /v1/agent/sessions/{session_id}/end` with your API key.

## 2. Public agent (keyless)

For agents with public access enabled in the dashboard (with an Origin allowlist), the browser can create the session directly. Public session creation is rate-limited per agent and per IP:

```js
const session = await AgentSession.start({ agentId: "your-agent-id" });
```

A keyless request against an agent without public access fails with [`agent_not_public`](errors.md); a page origin missing from the allowlist fails with [`origin_forbidden`](errors.md).
