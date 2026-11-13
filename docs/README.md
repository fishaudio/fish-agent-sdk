# Fish Agent Web SDK developer docs

Source of the developer documentation for embedding [Fish Audio](https://fish.audio) voice agents into websites and web apps. Plain Markdown, one topic per page, ready to be published as a docs site.

## Getting started

- [Quickstart](quickstart.md) gets you to a first call in the browser, with or without a backend.
- [Authentication](authentication.md) compares server-created session tokens with public agents.

## `@fishaudio/agent-client`

Framework-agnostic JavaScript/TypeScript SDK.

- [Sessions](sessions.md) covers `AgentSession.start` options, the session API, lifecycle, reconnection, and transports.
- [Events](events.md) is the event reference, including live transcripts.
- [Client tools](client-tools.md) lets the agent call functions in the browser.
- [Customization](customization.md) covers per-session overrides and dynamic variables.
- [Errors](errors.md) lists `FishAgentError` codes and what to do about each.

## `@fishaudio/agent-react-native`

- [React Native SDK](react-native.md) covers installation in Expo and bare React Native, the entry file, session tokens from a mobile app, `useConversation` additions, background calls, limitations, and troubleshooting.

## Building your own client

- [Realtime protocol](protocol.md) spells out the join handshake, readiness, messages, transcripts, reconnection, and end rules, for clients that do not use the SDK.

## `@fishaudio/agent-widget`

Drop-in `<fish-agent>` custom element. Two static lines put it on any site.
A `<FishAgentWidget>` React component lives under `@fishaudio/agent-widget/react`.

- [Widget](widget.md) covers the embed snippet, React component, attributes, theming, page events, and private-agent mode.

## `@fishaudio/agent-react`

React hooks and components on top of the client SDK.

- [React overview](react/README.md) covers installation, quickstart, and Next.js.
- [`useConversation`](react/useConversation.md) wraps the session lifecycle in a hook.
- [Provider](react/provider.md) shares one conversation across a component tree.
- [`useAgentMessages`](react/useAgentMessages.md) builds a streaming chat UI.
- [Audio visualization](react/audio-visualization.md) covers `useAudioLevels` and `<AgentAudioVisualizer />`.
