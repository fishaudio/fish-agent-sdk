---
"@fishaudio/agent-client": minor
"@fishaudio/agent-widget": minor
---

Start failures now say what went wrong. Three new `FishAgentError` codes cover starts that were already failing under a misleading code. A start that worked before still works.

- `invalid_session_token`: the `sessionToken` option is not the session-creation response. The message says what was received (`null`, a string, unparsed JSON text, an error body from your backend, an object wrapped in another one, camelCase keys, a missing `transport`, `livekit_url` or `token`) and how to fix it, and never contains the token. These cases used to fail with `unsupported_transport` ("uses transport "undefined" … please upgrade") or, for renamed keys, with `connection_failed` after the microphone prompt. `null` and `""` used to be treated as no token at all, which sent a keyless session request with no agent id.
- `insecure_context`: the browser reports the page as not a secure context (not https, not `localhost`) and exposes no microphone API to it. Reported before a session is created. It used to surface as `connection_failed`. A `microphone: false` start is not affected.
- `mic_unavailable`: no microphone could be captured at start (`NotFoundError`, `NotReadableError`, `OverconstrainedError`, `AbortError`, or an environment without `navigator.mediaDevices.getUserMedia`). It used to be `connection_failed`. A denied permission is still `mic_permission_denied`, and in-call device errors are unchanged.

`unsupported_transport` keeps its meaning: a token whose `transport` is a value this SDK version does not know, whatever else the token carries. A value that is not a token at all no longer lands on it.

On the web, a `sessionToken` is checked before the microphone is requested, so `invalid_session_token`, `unsupported_transport` and `session_expired` no longer cost a permission prompt. A call that passes both or neither of `agentId` and `sessionToken` also fails before the prompt. With `agentId` the order is unchanged: microphone first, then the session request. React Native is unchanged here: `startSession` asks for the system microphone permission first, as before.

Only what a connection needs is required of a token: `transport`, `livekit_url` and `token`. A token without `session_id` or `expires_at` connects as before, with no session id reported and no join deadline checked. Fields the SDK does not know are ignored. An unusable answer from the session endpoint in `agentId` mode is reported as `session_request_failed`.

If your code branches on `error.code`, add the new codes where you handle `unsupported_transport`, `connection_failed` or `mic_permission_denied` at start.

TypeScript: the `FishAgentErrorCode` union gains three members. Code that switches over it exhaustively, or builds a `Record<FishAgentErrorCode, …>`, needs the new cases to compile after upgrading.

The widget gains the optional `errorMicUnavailable` text ("No microphone available — check your device and try again.") for `mic_unavailable`. A page that overrides texts through `text-contents` or the agent's widget configuration without setting it keeps showing its own `errorConnection`, as before. For `insecure_context` and `invalid_session_token` it shows `errorUnavailable` and logs the reason to the console. A `sessionTokenProvider` that returns nothing now fails with `invalid_session_token` instead of a generic connection error.
