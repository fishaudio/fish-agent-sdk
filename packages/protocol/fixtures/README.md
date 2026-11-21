# Conformance fixtures

Shared test cases for SDKs that implement this protocol. They are plain JSON, so an SDK in any language can run the same cases with a small test runner of its own, and a behavior written down here is then checked on every platform.

The TypeScript client is the reference. Its runner is `packages/client/src/__tests__/fixtures.test.ts`, and a case goes in only once that runner passes with it.

These files are not published to npm.

## Rules for runners

- **Compare parsed JSON, never bytes.** Serializers differ in key order, slash escaping and number formatting.
- **Fail on anything you do not recognize.** An unknown key in a case, an unknown `kind`, or an unknown expectation is a test failure, not a skip. That is what forces all runners to be updated together when the format grows.
- **Do not assert error text** unless a case gives it. Error messages built from a platform error (`String(error)`) differ by platform.
- **Substitute placeholders** before comparing:

  | Placeholder | Meaning |
  |---|---|
  | `{{client_timezone}}` | The IANA zone the platform reports for the device. |
  | `{{sdk}}` | The SDK's own `X-Fish-SDK` value, for example `agent-client/1.1.0`. |

## Files

Every file is `{ "description": string, "cases": [...] }`. Every case has a unique `name`.

### `messages/agent-events.json`

A message arriving on the `agent-event` topic, and what the session does with it.

- `message`: the JSON object as received.
- `expect`: exactly one of
  - `{ "event": name, "payload": object }`: the session emits this one event with this payload. Names are the TypeScript event names (`toolCallStarted`, `toolCallCompleted`, `toolCallFailed`).
  - `{ "error": { "code", "stage"?, "recovered"? } }`: the session emits one `error` event. A key left out means the field is absent on the error.
  - `{ "ignored": true }`: no event is emitted and nothing is sent.
  - `{ "endReasonAfterDisconnect": reason }`: nothing is emitted yet; when the transport then disconnects with no reason of its own, the session ends with this reason.

### `messages/client-events.json`

A call on a connected session whose agent is ready, and what goes out on the `client-event` topic.

- `call`: `{ "method": "sendUserMessage", "text": string, "audio"?: boolean }`, or `{ "method": "sendUserActivity" | "interrupt" | "end" }`.
- `sent`: the messages sent, in order. An empty list means nothing is sent.

### `session/request.json`

Options for a public-agent start, and the session-creation request that results.

- `options`: option names as in the TypeScript `SessionRequestOptions`. `overrides` is passed through as written, in `snake_case`.
- `expect.url`: the full request URL.
- `expect.headers`: headers that must be present with these values.
- `expect.absentHeaders`: headers that must not be sent.
- `expect.body`: the request body.

### `session/errors.json`

A failed session-creation response, and the error it becomes.

- `response`: `{ "status": number, "json": value }` for a JSON body, `{ "status": number, "text": string }` for a body that is not JSON, or `{ "networkError": true }` when no response arrives.
- `options`: optional extra start options (only `origin` is used).
- `expect.code`: the error code.
- `expect.statusCode`: the HTTP status on the error, or `null` when the error carries none.
- `expect.message` / `expect.messageStartsWith` / `expect.messageContains`: optional checks on the error message.

### `session/tokens.json`

A session token passed in by the app, and whether the SDK accepts it.

- `token`: the token as the backend returned it. When `expiresAtOffsetMs` is given, the runner sets `expires_at` to that many milliseconds from now, in ISO 8601.
- `expect`: `{ "ok": true }`, or `{ "error": code, "messageContains"?: string }`.

### `tools/timeouts.json`

How long a client tool gets before the SDK answers for it.

- `call`: the fields to merge into the `client_tool.call` message. Leave `timeoutMs` out to test a runtime that does not send it.
- `fallbackMs`: the configured `clientToolTimeoutMs`.
- `expectMs`: the tool has not timed out one millisecond before this, and has timed out at it.

### `tools/results.json`

A `client_tool.call`, a tool handler, and the reply.

- `call`: the `client_tool.call` message.
- `handler.kind`:
  - `returns` (`value`): returns that JSON value.
  - `returnsNothing`: returns no value (`undefined`, `nil`, `null`).
  - `returnsStringOfLength` (`length`): returns a string of that many ASCII characters.
  - `echoesParams`: returns the params it was given.
  - `echoesContext`: returns `{ "callId", "toolName" }` from the context it was given.
  - `throws` (`message`): fails with that message.
  - `hangs`: never returns.
  - `unregistered`: no handler is registered under that name.
- `expect.reply`:
  - `none`: no `client_tool.result` is sent.
  - `result`: one `client_tool.result` without `isError`. With `expect.result`, its `result` equals that value; with `expect.resultAbsent`, it has no `result` key.
  - `error`: one `client_tool.result` with `isError: true`. With `expect.result`, its `result` equals that value.
- `expect.errorCode`: the code of the one `error` event the session emits, or `null` for none.

### `scenarios/session.json`

Scripts for the session state machine. Each case starts a session on a fake transport and then runs `steps` in order. A step either does something (`do`) or checks something (`expect`).

- `start.agent`: what the agent has done when the steps begin.
  - `ready` (the default): it joined and set its ready signal, as a current runtime does.
  - `joined`: it reported a state but no ready signal, as an older runtime does.
  - `absent`: it has not shown up.

Actions:

| `do` | Fields | What it is |
|---|---|---|
| `agentState` | `state` | The transport reports the agent's `lk.agent.state`. |
| `agentReady` | | The transport reports the agent's ready signal. |
| `agentEvent` | `message` | A message arrives on `agent-event`. |
| `transcription` | `role`, `segmentId`, `text`, `final` | A transcript update. `text` is the whole segment so far. |
| `connectionState` | `state`, `reason`? | The transport reports `connected`, `reconnecting` or `disconnected`. |
| `sendUserMessage` | `text`, `audio`? | The app sends a typed message. |
| `sendUserActivity`, `interrupt`, `end` | | The app calls that method. `end` waits for it to finish. |
| `advance` | `ms` | Time passes. Timers due at exactly the new time have fired. |

Expectations:

| `expect` | Fields | What is checked |
|---|---|---|
| `sent` | `messages` | The messages sent on `client-event` since the last `sent` check, in order. |
| `events` | `events`, `of`? | The events emitted since the last `events` check, in order, each as `{ "event", "payload" }`. With `of`, only events with those names are compared. `"events": "any"` discards them without checking. The first check also sees the events from starting the session. |
| `state` | `status`?, `mode`?, `endReason`? | The session's current values. `"endReason": null` means it has none. |

Event payloads are the TypeScript ones. `statusChange` and `modeChange` carry the value as a string. An `error` is `{ "code", "stage"?, "recovered"? }`. Do not check `connect`: its session ID differs between runners.
