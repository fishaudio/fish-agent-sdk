# @fishaudio/agent-widget

Embeddable `<fish-agent>` voice-agent widget for [Fish Audio](https://fish.audio) agents. A floating launcher expands into a voice-first chat card with live transcript, text input, client-tool chips, and a consent gate. It is a custom element rendering into shadow DOM, built on [`@fishaudio/agent-client`](https://www.npmjs.com/package/@fishaudio/agent-client).

Just want a script tag? [`@fishaudio/agent-widget-embed`](https://www.npmjs.com/package/@fishaudio/agent-widget-embed) is the same widget pre-bundled as one CDN file that registers `<fish-agent>` on load. No install, no build step:

```html
<fish-agent agent-id="your-agent-id"></fish-agent>
<script src="https://unpkg.com/@fishaudio/agent-widget-embed" async type="text/javascript"></script>
```

## Installation

```bash
npm install @fishaudio/agent-widget
```

## Quickstart

Importing the package has no side effects. Call `registerWidget()` once to define the element, then drop the tag anywhere:

```js
import { registerWidget } from "@fishaudio/agent-widget";
registerWidget(); // defines <fish-agent>
```

```html
<fish-agent agent-id="your-agent-id"></fish-agent>
```

Set `agent-id` for a public agent with your origin allowlisted. For a private agent, leave `agent-id` out and set the element's `sessionTokenProvider` property to a function that fetches a session token from your backend and returns the JSON unchanged:

```js
document.querySelector("fish-agent").sessionTokenProvider = async () => {
  const response = await fetch("/api/voice-session", { method: "POST" });
  if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
  return response.json();
};
```

Everything else is attributes: `agent-name`, `greeting`, `proactive-message`, `proactive-delay`, `position`, the `transcript`, `text-input`, `mic-muting`, and `consent` switches, `language`, `user-id`, `dynamic-variables` as JSON, and `text-contents` as JSON overriding any UI string. See the [attribute reference](https://docs.fish.audio/agents/deploy/widget#attributes). Theme it with CSS custom properties such as `--fish-accent` on the element.

The element emits bubbling, composed `CustomEvent`s. `fish-agent:call` carries mutable `{ options }`, so inject `clientTools` there. `fish-agent:connect` carries `{ sessionId }`, `fish-agent:disconnect` carries `{ reason }`, and `fish-agent:error` carries `{ code, message }`. Dispatch `fish-agent:expand` on the element or `document` to open the panel programmatically.

## React

`@fishaudio/agent-widget/react` exports a real `<FishAgentWidget>` component. It registers and renders the element, takes camelCase props, serializes object props, and surfaces the page events as callback props. `clientTools` is just a prop. Importing the entry also types the raw `<fish-agent>` tag in JSX. Requires React 18+ as an optional peer dependency.

```tsx
import { FishAgentWidget } from "@fishaudio/agent-widget/react";

<FishAgentWidget
  agentId="your-agent-id"
  clientTools={{ highlight_product: ({ productId }) => scrollToProduct(productId) }}
  onConnect={({ sessionId }) => console.log(sessionId)}
/>;
```

## Documentation

- [Widget](https://docs.fish.audio/agents/deploy/widget) covers behavior, attributes, theming, page events, and private agents.
- [Public agents](https://docs.fish.audio/agents/deploy/public-agents) and [authenticated sessions](https://docs.fish.audio/agents/deploy/authenticated-sessions) compare a public agent id with server-created session tokens.
- [Client tools](https://docs.fish.audio/agents/build/client-tools) lets the agent call functions in the browser.

## License

MIT. Icon path data comes from [lucide](https://lucide.dev) under ISC. See [THIRD-PARTY-NOTICES.txt](https://github.com/fishaudio/fish-agent-sdk-web/blob/main/packages/widget/THIRD-PARTY-NOTICES.txt), also shipped in this npm package.
