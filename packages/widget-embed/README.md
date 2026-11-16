# @fishaudio/agent-widget-embed

One-script CDN build of the [Fish Audio](https://fish.audio) `<fish-agent>` voice-agent widget. Loading it registers the element. It is a single minified IIFE that bundles [`@fishaudio/agent-widget`](https://www.npmjs.com/package/@fishaudio/agent-widget), the client SDK, preact, and livekit-client. No install, no build step.

## Usage

Add one script tag, from either CDN:

```html
<script src="https://unpkg.com/@fishaudio/agent-widget-embed" async type="text/javascript"></script>
```

```html
<script src="https://cdn.jsdelivr.net/npm/@fishaudio/agent-widget-embed" async type="text/javascript"></script>
```

Then place the element anywhere on the page:

```html
<fish-agent agent-id="your-agent-id"></fish-agent>
```

The agent must have public access enabled with your page's origin on its allowlist. For private agents, leave `agent-id` out and set the element's `sessionTokenProvider` property to a function that fetches a session token from your backend and returns the JSON unchanged:

```html
<fish-agent></fish-agent>
<script>
  document.querySelector("fish-agent").sessionTokenProvider = async () => {
    const response = await fetch("/api/voice-session", { method: "POST" });
    if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
    return response.json();
  };
</script>
```

The [widget guide](https://docs.fish.audio/agents/deploy/widget) lists all attributes, theming, and page events.

Bundling the widget yourself? Install [`@fishaudio/agent-widget`](https://www.npmjs.com/package/@fishaudio/agent-widget) instead and call `registerWidget()` once. React apps get `<FishAgentWidget>` from `@fishaudio/agent-widget/react`. This package is that widget pre-bundled for `<script src>` installs.

## License

MIT. The bundle inlines third-party software under Apache-2.0, BSD-3-Clause, MIT, and ISC licenses. See [THIRD-PARTY-NOTICES.txt](https://github.com/fishaudio/fish-agent-sdk-web/blob/main/packages/widget-embed/THIRD-PARTY-NOTICES.txt), also shipped in this npm package.
