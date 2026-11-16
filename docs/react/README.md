# React overview

`@fishaudio/agent-react` provides React hooks and components for Fish Audio voice agents, built on [`@fishaudio/agent-client`](../sessions.md). Authentication, events, client tools, and error semantics come from the client SDK. Everything documented there applies here.

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

  return (
    <div>
      <p>
        status: {conversation.status}
        {conversation.isSpeaking ? " · agent is speaking" : ""}
      </p>
      {conversation.status === "connected" ? (
        <>
          <button onClick={() => conversation.setMicMuted(!conversation.micMuted)}>
            {conversation.micMuted ? "Unmute" : "Mute"}
          </button>
          <button onClick={() => conversation.endSession()}>End call</button>
        </>
      ) : (
        <button onClick={start}>Start call</button>
      )}
    </div>
  );
}
```

The hook ends the session automatically when the component unmounts. Start calls made from the required user interaction path are safe under React StrictMode's effect replay.

## Package contents

- [`useConversation`](useConversation.md) owns one session's lifecycle. It is the primary entry point.
- [Provider](provider.md) covers `<AgentSessionProvider>` and the context hooks that share one conversation across a tree.
- [`useAgentMessages`](useAgentMessages.md) is a streaming chat log for building a chat UI.
- [Audio visualization](audio-visualization.md) covers `useAudioLevels` for meters and `<AgentAudioVisualizer />` for frequency bars.

The client package's key exports (`AgentSession`, `FishAgentError`, and their types) are re-exported, so app code can import everything from `@fishaudio/agent-react`.

## Next.js

The SDK only touches browser APIs when a session starts, so importing in Server Components is safe; components using the hooks need `"use client"`. Create session tokens in a Route Handler (`app/api/voice-session/route.ts`) with your `FISH_API_KEY`.
