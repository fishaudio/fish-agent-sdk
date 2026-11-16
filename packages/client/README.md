# @fishaudio/agent-client

Framework-agnostic JavaScript/TypeScript SDK for embedding [Fish Audio](https://fish.audio) voice agents into any website or web app: realtime voice over WebRTC, live transcripts, text input, and client tools. The API is small and event-driven.

Using React? [`@fishaudio/agent-react`](https://www.npmjs.com/package/@fishaudio/agent-react) wraps this SDK in hooks and components.

## Installation

```bash
npm install @fishaudio/agent-client
```

## Quickstart

```js
import { AgentSession } from "@fishaudio/agent-client";

// Session token from your backend, or { agentId } for a public agent.
const response = await fetch("/api/voice-session", { method: "POST" });
if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
const sessionToken = await response.json();

const session = await AgentSession.start({
  sessionToken,
  callbacks: {
    onModeChange: (mode) => setOrbState(mode), // "listening" | "thinking" | "speaking"
    onMessage: ({ role, text }) => renderChatBubble(role, text),
    onDisconnect: ({ reason }) => showCallEnded(reason),
  },
});

// Later:
session.sendUserMessage("Can you summarize that?");
await session.end();
```

Starting a session requests microphone access. Call `start()` from a user gesture such as a button click for the best permission and autoplay behavior. The page must be served over https, or from `localhost` during development: browsers give no microphone to other pages.

## Documentation

- [Quickstart](https://docs.fish.audio/agents/quickstart) gets you to a first call, with or without a backend.
- [Authenticated sessions](https://docs.fish.audio/agents/deploy/authenticated-sessions) and [public agents](https://docs.fish.audio/agents/deploy/public-agents) compare server-created session tokens with a public agent id.
- [Web SDK reference](https://docs.fish.audio/agents/deploy/web-sdk) covers `start()` options, the session API, lifecycle, and reconnection.
- [Events](https://docs.fish.audio/agents/deploy/web-sdk#events) is the event reference, including live transcripts.
- [Client tools](https://docs.fish.audio/agents/build/client-tools) lets the agent call functions in the browser.
- [Overrides](https://docs.fish.audio/agents/deploy/authenticated-sessions#overrides) and [dynamic variables](https://docs.fish.audio/agents/build/dynamic-variables) cover per-session customization.
- [Errors](https://docs.fish.audio/agents/deploy/web-sdk#errors) lists `FishAgentError` codes.
