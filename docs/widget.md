# Widget

The fastest way to put a Fish Audio agent on a website. Two static lines, no build step. The widget renders a floating launcher that expands into a voice-first chat card. The card has a live transcript, text input during the call, client-tool activity, an optional consent gate, and a minimized in-call pill.

```html
<fish-agent agent-id="your-agent-id"></fish-agent>
<script src="https://unpkg.com/@fishaudio/agent-widget-embed" async type="text/javascript"></script>
```

The agent must have public access enabled, and the page origin must be on its Origin allowlist. `localhost` and `127.0.0.1` count as separate origins. See [Authentication](authentication.md).

Bundlers can install the element instead: `npm install @fishaudio/agent-widget`, then call `registerWidget()` once. `@fishaudio/agent-widget-embed` is the same widget pre-bundled as one IIFE file that registers on load.

```js
import { registerWidget } from "@fishaudio/agent-widget";
registerWidget(); // defines <fish-agent>
```

React apps get a real component instead. `<FishAgentWidget>` registers and
renders the element. It takes camelCase props, serializes object props for you,
and exposes the page events as callback props. `clientTools` is just a prop:

```tsx
import { FishAgentWidget } from "@fishaudio/agent-widget/react";

<FishAgentWidget
  agentId="your-agent-id"
  clientTools={{ highlight_product: ({ productId }) => scrollToProduct(productId) }}
  onConnect={({ sessionId }) => console.log(sessionId)}
/>;
```

Every attribute below has a camelCase prop; `dynamicVariables` and
`textContents` take objects; `onCall(options)` still runs last for anything
else. Importing the entry also types the raw `<fish-agent>` element in JSX,
for pages that use the CDN script and install the package only for its types.

## How it behaves

- **Voice-first, typing welcome.** "Start a voice chat" asks for the microphone. Sending a text from the home screen starts the same session *without* the mic (`microphone: false`). There is no permission prompt until the user taps the mic button. The agent replies with voice either way.
- **Transcript** streams both sides in place; tool calls appear inline as expandable chips (name, status, input/output). Hide tool payloads by creating sessions with `tool_events: false` (see [Events](events.md#tool-call-lifecycle)).
- **Consent** (optional): a first-run terms card shown before the first session; acceptance is remembered in `localStorage`.
- **Minimize during a call** collapses the card to a floating pill with orb, waveform, timer, and hang-up. The call continues.
- **Screen stays awake during a session** (voice or text) via the SDK's default wake lock, so a call isn't cut short by the phone sleeping; the lock is released when the session ends.
- Mobile viewports get a full-screen sheet. `prefers-reduced-motion` disables the animations; state is always mirrored in text.

## Attributes

| Attribute | Description |
|---|---|
| `agent-id` | Public agent id. Required unless the `sessionTokenProvider` property is set. See Private agents below. |
| `server-url` | Fish API base override (default `https://api.fish.audio`). |
| `agent-name` | Display name in the header. |
| `greeting` | Home-screen headline. |
| `proactive-message` | Enables the attention bubble next to the launcher. |
| `proactive-delay` | Seconds before the bubble shows (default `3`). |
| `transcript` / `text-input` / `mic-muting` | Feature switches, default on; set `"false"` to disable. |
| `consent` | `"true"` shows the first-run terms card (default off). |
| `consent-text`, `terms-url`, `privacy-url`, `consent-key` | Consent copy, linked policies, and the localStorage key (default `fish-agent-consent`). |
| `position` | `bottom-right` (default), `bottom-left`, `top-right`, `top-left`. |
| `language` | Pin the session language (gated by the agent's override allowlist). |
| `dynamic-variables` | JSON string of `{{name}}` template values. |
| `user-id` | Your end-user identifier, stored on the session. |
| `text-contents` | JSON overriding any UI string (keys in `DEFAULT_TEXTS` of `@fishaudio/agent-widget`). |

Attributes win over the agent's server-side widget config (`GET /v1/agent/agents/{id}/widget`, fetched anonymously on load); built-in defaults fill the rest. The endpoint being unreachable never breaks the widget.

## Theming

Set CSS custom properties on the element. Internals live in a shadow root, so page CSS cannot reach them. Every token below is public:

```css
fish-agent {
  --fish-accent: #7c3aed;
  --fish-orb-color-1: #c4b5fd;
  --fish-orb-color-2: #4c1d95;
  --fish-radius: 16px;
  --fish-offset-x: 32px;
  --fish-offset-y: 32px;
  --fish-z-index: 999999;
}
```

Also available: `--fish-bg`, `--fish-text`, `--fish-text-secondary`, `--fish-border`, `--fish-bubble-agent-bg/-text`, `--fish-bubble-user-bg/-text`, `--fish-danger`, `--fish-live`, `--fish-fab-size`, `--fish-font`.

## Page API

Outbound `CustomEvent`s (bubbling, composed) on the element:

| Event | `detail` | When |
|---|---|---|
| `fish-agent:call` | `{ options }`, the **mutable** [`AgentSession.start` options](sessions.md) | Right before a session starts. Mutate `detail.options` to inject `clientTools`, `overrides`, `dynamicVariables`, or anything else. |
| `fish-agent:connect` | `{ sessionId }` | Session established. |
| `fish-agent:disconnect` | `{ reason }` | Session ended. |
| `fish-agent:error` | `{ code, message, stage?, recovered? }` | Start failure or in-call error (codes from [Errors](errors.md)). `stage` and `recovered` come with in-call `provider_error` / `internal_error` when the runtime reports them, see [In-call errors](errors.md#in-call-errors). The widget shows no error banner when `recovered` is `true`. |

Inbound: dispatch `fish-agent:expand` on the element or `document` to open the panel programmatically.

Registering client tools is just the `:call` event. React apps pass the
`clientTools` prop on `<FishAgentWidget>` instead, which does the same thing:

```js
document.querySelector("fish-agent").addEventListener("fish-agent:call", (event) => {
  event.detail.options.clientTools = {
    highlight_product: ({ productId }) => scrollToProduct(productId),
  };
});
```

## Private agents

Keep the agent non-public and set `sessionTokenProvider` instead of an
`agent-id`. It is a JS property on the element, since functions cannot be
attributes. The widget calls it before every session start. Fetch the session
token from your backend with whatever auth the request needs and return the
JSON verbatim. Your backend holds the API key and creates the session with
`POST /v1/agent/sessions`. Origin checks, user auth, and rate limiting on that
endpoint are yours.

```html
<fish-agent agent-name="Support"></fish-agent>
<script>
  document.querySelector("fish-agent").sessionTokenProvider = async () => {
    const response = await fetch("/api/voice-session", {
      method: "POST",
      headers: { Authorization: `Bearer ${appSession.token}` },
    });
    return response.json(); // the session-token JSON, verbatim
  };
</script>
```

React apps pass the same function as the `sessionTokenProvider` prop on
`<FishAgentWidget>`.
