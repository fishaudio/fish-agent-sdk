---
"@fishaudio/agent-widget": minor
---

The widget no longer shows its "connection failed" banner for an in-call `provider_error` / `internal_error` the agent is recovering from on its own (`recovered` is `true`), so a transient retry no longer looks like a broken call. The `fish-agent:error` event detail, and the React wrapper's `onError`, now include `stage` and `recovered` when the runtime reports them (typed as `FishAgentWidgetErrorDetail`), so the host page can tell a recovered retry from a lost turn.
