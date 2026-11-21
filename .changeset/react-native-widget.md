---
"@fishaudio/agent-widget-react-native": minor
"@fishaudio/agent-widget": patch
---

New `@fishaudio/agent-widget-react-native`: the drop-in voice widget for React Native apps. A floating button opens a call panel with live transcript, text input, mute, consent and tool chips, the counterpart of the web `<fish-agent>` element, built on `@fishaudio/agent-react-native`'s `useConversation`. With `draggable` (React Native only, off by default), the user can drag the button and the minimized call pill; it snaps to the nearer side and keeps its place for the app's run. The web widget now shares its settings, transcript store and helpers with it through an internal package; its behavior and exports are unchanged.
