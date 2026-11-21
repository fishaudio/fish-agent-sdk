---
"@fishaudio/agent-ios": minor
"@fishaudio/agent-android": minor
---

New: native iOS and Android SDKs. Both are headless and follow the Web and React Native SDKs: the same session options, events, error codes, end reasons and client tool rules, behind one `Conversation` object (published properties on iOS, `StateFlow`s on Android). They add what a phone needs: the microphone permission, audio routing (`auto`, `speaker`, `earpiece`), and on Android a foreground service that keeps the microphone running in the background. Checked on an iPhone 12 and a Pixel 8; the docs list what was checked and what is still open.
