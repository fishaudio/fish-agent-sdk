# Fish Agent Android SDK

Voice calls with a [Fish Audio](https://fish.audio) agent in a native Android app.

```kotlin
val conversation = Conversation(context)

if (FishAgentPermissions.requestMicrophonePermission(activity)) {
    val token = SessionToken.fromJson(responseBodyFromYourBackend)
    conversation.startSession(SessionAuth.Token(token))
}
```

- **Docs:** [`docs/android.md`](../docs/android.md)
- **Example app:** [`examples/android`](../examples/android)
- **Requirements:** Android 7.0 (API 24). Apps need the JitPack repository, for a dependency of LiveKit.

It has been checked on an emulator only so far. The docs list what is still to be checked on phones.

## Working on it

```sh
cd android
./gradlew :agent:testDebugUnitTest :agent:lintDebug
```

The tests run on the JVM. They include the conformance fixtures shared with the other SDKs (`packages/protocol/fixtures`) and replays of event sequences recorded from real calls (`agent/src/test/resources/livekit-recordings`).

The library's version comes from `package.json` in this directory, which only exists so the SDK is versioned together with the JavaScript packages. Do not edit it by hand: `pnpm version-packages` updates it.
