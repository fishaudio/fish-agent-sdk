---
"@fishaudio/agent-client": minor
"@fishaudio/agent-widget": minor
---

Start failures now say what went wrong. Three new `FishAgentError` codes, and a `sessionToken` is checked before the microphone prompt.

- `invalid_session_token`: the `sessionToken` option is not the session-creation response. The message says what was received (`null`, a string, unparsed JSON text, an error body from your backend, an object wrapped in another one, camelCase keys, missing fields) and how to fix it, and never contains the token. These cases used to fail with `unsupported_transport` ("uses transport "undefined" … please upgrade") or, for renamed keys, with `connection_failed` after the microphone prompt. `null` and `""` used to be treated as no token at all, which sent a keyless session request with no agent id.
- `insecure_context`: the page is not served over https or from `localhost`, so the browser gives it no microphone. Reported before a session is created. It used to surface as `connection_failed`. A `microphone: false` start is not affected.
- `mic_unavailable`: no microphone could be captured at start (`NotFoundError`, `NotReadableError`, `OverconstrainedError`, `AbortError`, or a browser without a capture API). It used to be `connection_failed`. A denied permission is still `mic_permission_denied`, and in-call device errors are unchanged.

`unsupported_transport` now only means what it says: a well-formed token whose `transport` this SDK version does not know.

With `sessionToken`, the token's shape, transport and join deadline are checked before the microphone is requested, so `unsupported_transport` and `session_expired` no longer cost a permission prompt. A call that passes both or neither of `agentId` and `sessionToken` also fails before the prompt. With `agentId` the order is unchanged: microphone first, then the session request. A session token must carry `transport`, `session_id`, `expires_at`, `livekit_url` and `token`; one trimmed to fewer fields is now rejected. Fields the SDK does not know are still ignored. An unusable answer from the session endpoint in `agentId` mode is reported as `session_request_failed`.

If your code branches on `error.code`, add the new codes where you handle `unsupported_transport`, `connection_failed` or `mic_permission_denied` at start.

The widget shows the new `errorMicUnavailable` text ("No microphone available — check your device and try again.") for `mic_unavailable`. For `insecure_context` and `invalid_session_token` it shows `errorUnavailable` and logs the reason to the console.
