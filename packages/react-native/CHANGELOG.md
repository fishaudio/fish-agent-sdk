# @fishaudio/agent-react-native

## 1.1.0

### Minor Changes

- 57aeb33: New package: React Native SDK. `useConversation` adds the microphone permission, the audio session, audio routing (`auto`, `speaker`, `earpiece`), and an Android foreground service for background calls to the React SDK hook. Includes an Expo config plugin for the iOS microphone text and background audio.

### Patch Changes

- 57aeb33: `startSession` installs the WebRTC globals itself when `setupFishAgent()` was not called, instead of failing with a bare `connection_failed`. Peer dependencies now name the versions the SDK was tested with (Expo 58, React Native 0.88, `@livekit/react-native` 3.1, `@livekit/react-native-webrtc` 150.1). New `docs/react-native.md` page.
- 57aeb33: Expo is now optional. The Android call service is a plain React Native module picked up by autolinking, so bare React Native apps can use the package; Expo apps keep the config plugin and need no changes.
- 57aeb33: Hanging up during `startSession` no longer leaves the audio session or the Android call service running, and a quick redial is not released by the cancelled start. The Android call service always enters the foreground before it stops, avoiding a crash when a call ends right after it starts. A warning is logged when the call service cannot start.
- Updated dependencies [57aeb33]
- Updated dependencies [57aeb33]
- Updated dependencies [57aeb33]
  - @fishaudio/agent-client@1.1.0
  - @fishaudio/agent-react@1.1.0
