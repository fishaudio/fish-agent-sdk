# Handoff: docs.fish.audio updates for the mobile SDKs

For whoever maintains docs.fish.audio. The pages in this folder are the source; these are the changes the site needs.

## 1. New page: React Native SDK

- **Source:** [`docs/react-native.md`](react-native.md)
- **Live at** `https://docs.fish.audio/agents/deploy/react-native` since 2026-11-17 (fishaudio/docs#362), next to `web-sdk` and `react-sdk` in the Deploy section. Keep it in step with the source.
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
- **Native apps and public agents:** since platform-api #3282 (2026-11-16), a public agent takes any origin, including none, unless it restricts origins, so an app connects with just `agentId`. For a restricted agent the SDK's experimental `origin` option supplies one. The live Public Agents page already says non-browser clients can set any `Origin`.

## 3. Existing pages: Web SDK, React SDK

- Add a line pointing React Native developers to the new page.
- `clientToolTimeoutMs`: the SDK now uses the agent's own wait, less a margin of up to 1 s, when the runtime sends `timeoutMs`, and falls back to `clientToolTimeoutMs` (default 15 s) otherwise. The source wording is in [`client-tools.md`](client-tools.md) and [`errors.md`](errors.md).

## 4. New pages: iOS SDK and Android SDK

- **Sources:** [`docs/ios.md`](ios.md) and [`docs/android.md`](android.md).
- **Suggested URLs:** `/agents/deploy/ios` and `/agents/deploy/android`, next to `react-native` in the Deploy section.
- Both pages open with a status note: checked on a simulator and an emulator only. Keep it until the phone checks are done; the lists of what is still open are in `examples/ios/README.md` and `examples/android/README.md`.
- The iOS page has three known problems under Limitations. They are real and should be published as written.
- Relative links in the two pages map to the same site URLs as the React Native page's (table in section 1). Two more:

  | In the source | On the site |
  |---|---|
  | `react-native.md#public-agent` | `/agents/deploy/react-native#public-agent` |
  | `../examples/ios`, `../examples/android` | the directories on GitHub |

- The Web SDK, React SDK and React Native pages should each point native developers to the two new pages.

## 5. Wire Protocol page: notes for native clients

[`docs/protocol.md`](protocol.md) gained notes that came out of recording real calls with LiveKit's Android and Swift SDKs:

- Section 2: on Android, set `"pending"` only after the room is connected.
- Section 6: after `Reconnected`, wait a moment before treating an empty roster as a hangup; handle only `agent-event`.
- Section 7: on iOS, a short wait before believing the agent left; empty attribute values are no values.
- Known gaps: the opening line spoken before the client is connected, the reason announced for a backend-forced end, and an unannounced hangup after a long outage. These three are for the runtime team as much as for the page.
