# @fishaudio/agent-react

React hooks and components for [Fish Audio](https://fish.audio) voice agents, built on [`@fishaudio/agent-client`](https://www.npmjs.com/package/@fishaudio/agent-client).

## Installation

```bash
npm install @fishaudio/agent-react
```

Requires React 18+.

## Quickstart

```tsx
"use client";

import { useConversation } from "@fishaudio/agent-react";

export function VoiceWidget() {
  const conversation = useConversation();

  const start = async () => {
    const response = await fetch("/api/voice-session", { method: "POST" });
    if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
    const sessionToken = await response.json();
    await conversation.startSession({ sessionToken });
  };

  return conversation.status === "connected" ? (
    <button onClick={() => conversation.endSession()}>
      End call{conversation.isSpeaking ? " · speaking" : ""}
    </button>
  ) : (
    <button onClick={start}>Start call</button>
  );
}
```

The hook ends the session automatically when the component unmounts. Start calls made from the required user interaction path are safe under React StrictMode's effect replay.

## Documentation

- [React SDK](https://docs.fish.audio/agents/deploy/react-sdk) covers the quickstart, Next.js, `useConversation`, the provider, `useAgentMessages`, and audio visualization.

Authentication, events, client tools, and errors are documented with the [Web SDK](https://docs.fish.audio/agents/deploy/web-sdk). Everything there applies here.
