# @fishaudio/agent-widget-embed

## 1.0.0

### Major Changes

- First stable release. The public API is the one 0.4.1 shipped plus the additions in this release, nothing was removed or renamed, so upgrading from 0.4.x needs no code changes. From 1.0.0 on the packages follow semantic versioning: a breaking change arrives only in a new major version.

### Patch Changes

- Updated dependencies [66058fc]
- Updated dependencies
  - @fishaudio/agent-widget@1.0.0

## 0.4.1

### Patch Changes

- @fishaudio/agent-widget@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [1e263f5]
  - @fishaudio/agent-widget@0.4.0

## 0.3.0

### Patch Changes

- @fishaudio/agent-widget@0.3.0

## 0.2.1

### Patch Changes

- b05db7d: Republish with resolved internal dependency ranges. The 0.2.0 tarballs declared their `@fishaudio/*` dependencies with the `workspace:^` protocol, which npm cannot install; packing and publishing now go through pnpm only, and a release-time check verifies the packed manifests.
- Updated dependencies [b05db7d]
  - @fishaudio/agent-widget@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies [d64ffb4]
  - @fishaudio/agent-widget@0.2.0

## 0.1.0

### Minor Changes

- Revise `SessionOverrides`: rename `voice_profile_id` to `voice_id`, add `first_message_prompt` (mutually exclusive with `first_message`), and move the language override fully into `overrides.language` — the top-level `language` request field is gone. The `language` start option still works and now folds into overrides client-side; an explicit `overrides.language` wins. Keyless (public) session creation accepts only the `language` and `voice_id` overrides.

### Patch Changes

- Updated dependencies
  - @fishaudio/agent-widget@0.1.0
