---
"@fishaudio/agent-react-native": patch
---

Android: the call service passes the microphone foreground-service type only on Android 11 and later, where it exists. On Android 10 it was passed too, which could make the system refuse the service.
