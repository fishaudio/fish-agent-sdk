# Quickstart

Embed a [Fish Audio](https://fish.audio) voice agent into any website or web app: realtime voice over WebRTC, live transcripts, text chat, and client tools. The API is small and event-driven.

## Prerequisites

- An agent created and **published** in the [Fish Audio dashboard](https://fish.audio).
- A Fish Audio API key (for private agents), or an agent with public access enabled (for keyless embedding).

```bash
npm install @fishaudio/agent-client
```

Using React? Install [`@fishaudio/agent-react`](react/README.md) instead. It wraps this SDK in hooks and components.

## Authenticated agents

The session is created on your server (which holds your API key) and joined from the browser.

**1. Server:** create a short-lived session token and return it to the browser:

```js
// e.g. POST /api/voice-session
app.post("/api/voice-session", async (req, res) => {
  const response = await fetch("https://api.fish.audio/v1/agent/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.FISH_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agent_id: process.env.FISH_AGENT_ID }),
  });
  res.status(response.status).json(await response.json());
});
```

**2. Browser:** fetch the token from your server when the call starts, then join. The token must be used within about 5 minutes and starts one call, so fetch it when the call starts, not at page load. `AgentSession.start` requests microphone access, streams the mic to the agent, and plays the agent's voice through the speakers. Browsers only allow that from a user gesture, so call it from a click handler. They also give the microphone only to pages served over https, or from `localhost` during development.

```js
import { AgentSession } from "@fishaudio/agent-client";

const response = await fetch("/api/voice-session", { method: "POST" });
if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
const sessionToken = await response.json();

const session = await AgentSession.start({
  sessionToken,
  callbacks: {
    onModeChange: (mode) => console.log(mode), // listening | thinking | speaking
    onMessage: ({ role, text }) => console.log(role, text),
  },
});
```

## Public agents

A public agent needs no server. Enable public access on the agent in the dashboard and add your page origin to its allowlist. Then start the session in the browser with the `agentId`. `start` still uses the mic and speaker, so call it from a click handler.

```js
import { AgentSession } from "@fishaudio/agent-client";

const session = await AgentSession.start({
  agentId: "your-agent-id",
  callbacks: {
    onModeChange: (mode) => console.log(mode), // listening | thinking | speaking
    onMessage: ({ role, text }) => console.log(role, text),
  },
});
```

## Next steps

- [Authentication](authentication.md) covers both modes in detail, with server snippets.
- [Sessions](sessions.md) lists everything `start()` accepts and the full session API.
- [Events](events.md) covers transcripts, agent mode, and the chat-log `message` event.
- [React overview](react/README.md) shows the same flow with hooks.

## Browser support

Modern evergreen browsers with WebRTC and WebAudio. The SDK is SSR-safe: importing it on the server is fine; only `start()` touches browser APIs.
