# @fishaudio/agent-widget

## 1.0.0

### Major Changes

- First stable release. The public API is the one 0.4.1 shipped plus the additions in this release, nothing was removed or renamed, so upgrading from 0.4.x needs no code changes. From 1.0.0 on the packages follow semantic versioning: a breaking change arrives only in a new major version.

### Minor Changes

- 66058fc: Keyless session requests now fail with `insufficient_credit` when the agent owner's account has no Agent credit left (HTTP 402). The API used to answer with a neutral 403 that the SDK reported as `agent_not_public`, which sent integrators to re-check their public-access settings when the fix was a top-up. The widget shows the new `errorUnavailable` text ("This agent is temporarily unavailable.") for it.

### Patch Changes

- Updated dependencies [66058fc]
- Updated dependencies [3efd8ac]
- Updated dependencies
  - @fishaudio/agent-client@1.0.0

## 0.4.1

### Patch Changes

- Updated dependencies [672404a]
  - @fishaudio/agent-client@0.4.1

## 0.4.0

### Minor Changes

- 1e263f5: The widget no longer shows its "connection failed" banner for an in-call `provider_error` / `internal_error` the agent is recovering from on its own (`recovered` is `true`), so a transient retry no longer looks like a broken call. The `fish-agent:error` event detail, and the React wrapper's `onError`, now include `stage` and `recovered` when the runtime reports them (typed as `FishAgentWidgetErrorDetail`), so the host page can tell a recovered retry from a lost turn.

### Patch Changes

- Updated dependencies [1e263f5]
- Updated dependencies [1e263f5]
- Updated dependencies [e2751b1]
- Updated dependencies [6759dc7]
  - @fishaudio/agent-client@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [4e2d043]
  - @fishaudio/agent-client@0.3.0

## 0.2.1

### Patch Changes

- b05db7d: Republish with resolved internal dependency ranges. The 0.2.0 tarballs declared their `@fishaudio/*` dependencies with the `workspace:^` protocol, which npm cannot install; packing and publishing now go through pnpm only, and a release-time check verifies the packed manifests.
- Updated dependencies [98ceef5]
- Updated dependencies [e258acc]
- Updated dependencies [b05db7d]
  - @fishaudio/agent-client@0.2.1

## 0.2.0

### Minor Changes

- d64ffb4: Typed turns now default to a text-only reply. `sendUserMessage(text)` sends `audio: false` unless called with `{ audio: true }`, so the agent answers typed input as streaming transcript text without synthesizing speech. Previously the default was a spoken reply and `{ audio: false }` was the opt-out. The widget follows the new default: typed messages in the widget also get a text-only reply. The wire protocol is unchanged — an absent `audio` field still means a spoken reply for raw-protocol clients.

### Patch Changes

- Updated dependencies [80d5489]
- Updated dependencies [d64ffb4]
  - @fishaudio/agent-client@0.2.0

## 0.1.0

### Minor Changes

- Revise `SessionOverrides`: rename `voice_profile_id` to `voice_id`, add `first_message_prompt` (mutually exclusive with `first_message`), and move the language override fully into `overrides.language` — the top-level `language` request field is gone. The `language` start option still works and now folds into overrides client-side; an explicit `overrides.language` wins. Keyless (public) session creation accepts only the `language` and `voice_id` overrides.

### Patch Changes

- Updated dependencies
  - @fishaudio/agent-client@0.1.0
