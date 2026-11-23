# Releasing

All packages share one version: the npm packages and the iOS SDK. Changesets bumps them together (`fixed` in `.changeset/config.json`). `ios/package.json` is a private marker that carries the iOS SDK's version; it is never published to npm.

npm cannot take a release back. The order below puts every step that can fail before it.

## Before the first iOS release

- **The repository's name.** Swift Package Manager takes a package's identity from the last part of its URL, `fish-agent-sdk` today. Renaming the repository after apps depend on the package changes that identity for them, so settle the name before the first release.

## Steps

1. **Version.** `pnpm version-packages` applies the pending changesets and regenerates `ios/Sources/FishAgent/Version.swift`. Commit as `chore(release): version packages to X.Y.Z`.

2. **Check.**

   ```sh
   pnpm build && pnpm typecheck && pnpm check:publish && pnpm check:native-version && pnpm test
   swift test
   ```

3. **Publish to npm.** `pnpm release`.

4. **Tag for Swift Package Manager.** SPM reads versions from plain semantic-version tags, not the `@fishaudio/…@X.Y.Z` tags changesets makes:

   ```sh
   git tag X.Y.Z && git push origin X.Y.Z
   ```

   The tag must be on the commit from step 1, which holds the matching `Version.swift`.

## Notes

- The old tags `v0.1.0` and `v0.2.0` look like package versions to SPM and have no `Package.swift`. Apps avoid them by depending on the first version that includes the iOS SDK or later.
- A fix that only touches the iOS SDK still releases every package under a new version. That is the cost of one version number.
