---
"@fishaudio/agent-react-native": patch
---

Hanging up during `startSession` no longer leaves the audio session or the Android call service running, and a quick redial is not released by the cancelled start. The Android call service always enters the foreground before it stops, avoiding a crash when a call ends right after it starts. A warning is logged when the call service cannot start.
