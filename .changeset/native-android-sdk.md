---
"@fishaudio/agent-android": minor
---

New: a native Android SDK, `com.fishaudio.agent:agent-android`. It is headless and follows the Web and React Native SDKs: the same session options, events, error codes, end reasons and client tool rules, behind one `Conversation` object with `StateFlow` state. It adds what a phone needs: a helper for the microphone permission, audio routing (`auto`, `speaker`, `earpiece`), and a foreground service that keeps the microphone running in the background. Checked on a Pixel 8; the docs list what was checked and what is still open.
