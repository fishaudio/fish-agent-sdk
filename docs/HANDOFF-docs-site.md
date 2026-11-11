# Handoff: docs.fish.audio updates for the React Native SDK

For whoever maintains docs.fish.audio. The pages in this folder are the source; these are the changes the site needs.

## 1. New page: React Native SDK

- **Source:** [`docs/react-native.md`](react-native.md)
- **Chinese version:** [`docs/react-native.zh-CN.md`](react-native.zh-CN.md), kept section-for-section in sync with the English page; use it if the site has a Chinese locale.
- **Suggested URL:** `https://docs.fish.audio/agents/deploy/react-native` (does not exist yet), next to `web-sdk` and `react-sdk` in the Deploy section.
- The package's `homepage` in `packages/react-native/package.json` already points at that URL, so npm links there once the page is live.
- The page links to other pages in this folder by relative path; map them to the site URLs (the same ones the package READMEs use):

  | Link in the source | Site URL |
  |---|---|
  | `README.md` (Web SDK) | `/agents/deploy/web-sdk` |
  | `react/useConversation.md` (React SDK) | `/agents/deploy/react-sdk` |
  | `authentication.md` | `/agents/deploy/authenticated-sessions` (public agents: `/agents/deploy/public-agents`) |
  | `events.md` | `/agents/deploy/web-sdk#events` |
  | `client-tools.md` | `/agents/build/client-tools` |
  | `errors.md` | `/agents/deploy/web-sdk#errors` |

## 2. Existing page: Wire Protocol (`/agents/deploy/protocol`)

The live page covers the channels and messages but not the behavior a working client needs. [`docs/protocol.md`](protocol.md) has it; suggested additions to the live page:

- **Join handshake:** announce `fish.client.audio_ready = "pending"` right after connecting, report the ready value (attribute and `client.audio_ready` message) once the agent's audio plays, re-publish after a full reconnect.
- **Readiness and queueing:** `fish.agent.ready` is the ready signal; `lk.agent.state` arrives 2–4 s earlier and only proves the agent joined (fall back to it after about 8 s). Messages sent before ready are lost, so clients queue them. Agent join timeout: 15 s.
- **`client_tool.call.timeoutMs`** (new optional field) and the roughly 60 KB result limit.
- **Reconnection:** treat both `SignalReconnecting` and `Reconnecting` as reconnecting; what to re-check after `Reconnected`.
- **End rules:** `session.ended` first, then agent left / `ROOM_DELETED` / `ROOM_CLOSED` as `agent_hangup`, else `connection_lost`; the 10 s grace period.
- **Native apps and public agents:** public mode checks the browser `Origin` and is meant for websites; apps should get tokens from their own backend.

## 3. Existing pages: Web SDK, React SDK

- Add a line pointing React Native developers to the new page.
- `clientToolTimeoutMs`: the SDK now uses the agent's own wait when the runtime sends `timeoutMs`, and falls back to `clientToolTimeoutMs` (default 15 s) otherwise. The source wording is in [`client-tools.md`](client-tools.md) and [`errors.md`](errors.md).
