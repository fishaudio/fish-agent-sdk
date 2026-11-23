---
"@fishaudio/agent-react-native": minor
---

Requires `@livekit/react-native` 3.2 and `@livekit/react-native-webrtc` 150.2 (peer ranges `>=3.2.0` and `>=150.2.0`). With the earlier 150.1 WebRTC, Android release builds failed in R8 (`Missing class livekit.org.jni_zero.JniZeroJni`), and Expo SDK 58 turns R8 on for release builds by default. Upgrade the LiveKit packages together, including `@livekit/react-native-expo-plugin` 1.2 on Expo.
