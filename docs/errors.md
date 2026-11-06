# Errors

All failures are `FishAgentError` with a stable `code` (plus `statusCode` for session-request HTTP errors). `start()` rejects with one. Recoverable in-call failures surface through the `error` event instead. In-call `provider_error` and `internal_error` events also carry `stage` and `recovered` when the runtime reports them, see [In-call errors](#in-call-errors).

```js
import { FishAgentError } from "@fishaudio/agent-client";

try {
  await AgentSession.start({ sessionToken });
} catch (error) {
  if (error instanceof FishAgentError && error.code === "mic_permission_denied") {
    showMicHelp();
  }
}
```

| Code | Meaning |
|---|---|
| `session_request_failed` | The session endpoint rejected the request or was unreachable. |
| `agent_not_public` | Keyless session request against an agent without public access. |
| `origin_forbidden` | Page origin is not on the agent's allowlist. |
| `insufficient_credit` | Keyless session request, but the agent owner's account has no Agent credit left (HTTP 402). The owner needs to top up. |
| `unsupported_transport` | The session uses a transport this SDK version doesn't know. Upgrade the package. |
| `mic_permission_denied` | The user declined microphone access. |
| `device_change_failed` | A requested audio device could not be activated, or the browser does not support output selection (`setSinkId`, common on mobile browsers). Output stays on the previous device; a failed mic switch switches back to the previous microphone (best effort). |
| `connection_failed` | The realtime connection could not be (re)established, a send to the agent failed, the agent never joined the session (15 s), or the microphone could not be toggled. |
| `session_expired` | The session token's join deadline passed before connecting. |
| `tool_failed` | A client tool threw, was not registered, or its result could not be delivered. See [Client tools](client-tools.md). |
| `tool_timeout` | A client tool exceeded `clientToolTimeoutMs` (default 15 s). |
| `provider_error` | An upstream model or speech provider failed during the session. Delivered as an `error` event, with `stage` and `recovered` when the runtime reports them. The session may recover. |
| `internal_error` | The agent runtime hit an internal error. Delivered as an `error` event, with `stage` and `recovered` when the runtime reports them. The session may recover. |

## In-call errors

`provider_error` and `internal_error` describe one failed step of one turn, never the session as a whole. The runtime adds two fields so the UI can pick the right strength of message:

| Field | Values | Meaning |
|---|---|---|
| `stage` | `"llm"` \| `"stt"` \| `"tts"` \| `"runtime"` | Which part of the pipeline failed. `runtime` is the runtime's own code. |
| `recovered` | `boolean` | `true`: the runtime is still going to answer this turn by itself (a retry or a silent regeneration). Show at most a light "retrying" hint. `false`: the turn is lost and the user has to act, for example repeat what they said. |

Both are `undefined` against an older runtime that does not send them, and on the bare `internal_error` the server sends as its last frame before closing a call it has given up on (the session then ends with a transport-derived [`EndReason`](sessions.md#ending)). Neither value means the session has ended, and neither says anything about tool calls that ran earlier in the turn. A session that is closed because of repeated failures ends with its own `EndReason`.

```js
session.on("error", (error) => {
  if (error.code !== "provider_error" && error.code !== "internal_error") return;
  if (error.recovered) {
    showToast("One moment...");
  } else {
    showBanner("Sorry, I missed that. Could you say it again?");
  }
});
```
