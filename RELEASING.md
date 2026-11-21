# Releasing

All packages share one version: the six npm packages, the iOS SDK and the Android SDK. Changesets bumps them together (`fixed` in `.changeset/config.json`). `ios/package.json` and `android/package.json` are private markers that carry the native SDKs' version; they are never published to npm.

npm and Maven Central cannot take a release back. The order below puts every step that can fail before the first step that cannot be undone.

## Before the first native release

These are decided once:

- **The repository's name.** Swift Package Manager takes a package's identity from the last part of its URL, `fish-agent-sdk` today. Renaming the repository after apps depend on the package changes that identity for them, so settle the name before the first release.
- **The Maven Central namespace.** The Android library is `com.fishaudio.agent:agent-android`, which needs the `com.fishaudio` namespace verified on the [Central Portal](https://central.sonatype.com) through a DNS record on `fishaudio.com`. If only `fish.audio` can be verified, the group (and the Kotlin package) become `audio.fish…`: change `group` in `android/agent/build.gradle.kts` before the first release, not after.
- **A signing key.** Maven Central requires GPG signatures. Put the key in `~/.gradle/gradle.properties` as `signingInMemoryKey` (the ASCII-armored private key) and `signingInMemoryKeyPassword`.

## Steps

1. **Version.** `pnpm version-packages` applies the pending changesets and regenerates `ios/Sources/FishAgent/Version.swift`. Commit as `chore(release): version packages to X.Y.Z`.

2. **Check.**

   ```sh
   pnpm build && pnpm typecheck && pnpm check:publish && pnpm check:native-version && pnpm test
   swift test
   (cd android && ./gradlew :agent:testDebugUnitTest :agent:lintDebug)
   ```

3. **Stage the Android library.** This writes the signed artifacts to `android/agent/build/staging-repo` and uploads nothing:

   ```sh
   (cd android && ./gradlew :agent:publishReleasePublicationToStagingRepository)
   ```

   Zip the `com` directory inside it and upload the zip to the Central Portal as a deployment with **manual** publishing. The portal validates the signatures, the POM and the namespace. Do not press Publish yet. If validation fails, fix it and start again: nothing has been released.

4. **Publish to npm.** `pnpm release`.

5. **Tag for Swift Package Manager.** SPM reads versions from plain semantic-version tags, not the `@fishaudio/…@X.Y.Z` tags changesets makes:

   ```sh
   git tag X.Y.Z && git push origin X.Y.Z
   ```

   The tag must be on the commit from step 1, which holds the matching `Version.swift`.

6. **Publish the Android library.** Press Publish on the validated deployment in the Central Portal.

## Notes

- The old tags `v0.1.0` and `v0.2.0` look like package versions to SPM and have no `Package.swift`. Apps avoid them by depending on the first version that includes the iOS SDK or later.
- A fix that only touches one native SDK still releases every package under a new version. That is the cost of one version number.
