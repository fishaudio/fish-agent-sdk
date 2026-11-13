---
"@fishaudio/agent-react-native": patch
---

`startSession` installs the WebRTC globals itself when `setupFishAgent()` was not called, instead of failing with a bare `connection_failed`. Peer dependencies now name the versions the SDK was tested with (Expo 58, React Native 0.88, `@livekit/react-native` 3.1, `@livekit/react-native-webrtc` 150.1). New `docs/react-native.md` page.
