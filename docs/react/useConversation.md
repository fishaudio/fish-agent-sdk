# `useConversation(defaults?)`

Owns one session's lifecycle and re-renders on its state changes. `defaults` is merged into every `startSession(overrides?)` call. Overrides win per key. Put long-lived options like `clientTools`, `callbacks`, or a public `agentId` in `defaults`. Put per-call values like a freshly fetched `sessionToken` in `overrides`. The latest render of `defaults` is used, so inline objects are fine.

```tsx
const conversation = useConversation({ clientTools, callbacks });

const start = async () => {
  const response = await fetch("/api/voice-session", { method: "POST" });
  if (!response.ok) throw new Error(`Session request failed: ${response.status}`);
  const sessionToken = await response.json();
  await conversation.startSession({ sessionToken });
};
```

## Returned value

| Returned | Type | Description |
|---|---|---|
| `startSession` | `(overrides?) => Promise<string>` | Creates the session (if needed), connects, resolves with the session id. |
| `endSession` | `() => Promise<void>` | Graceful hangup. Safe to call at any time. |
| `status` | `"idle" \| SessionStatus` | `"idle"` before the first start and after an uncancelled failed start, then `"connecting" → "connected" ⇄ "reconnecting" → "ended"`. |
| `mode` | `AgentMode` | `"listening" \| "thinking" \| "speaking"`. Drives a talking-orb UI. |
| `isSpeaking` | `boolean` | Shorthand for `mode === "speaking"`. |
| `micMuted` / `setMicMuted` | `boolean` / `(muted) => Promise<void>` | Microphone control. Mirrors the session. After a `microphone: false` start it begins `true`. |
| `sendUserMessage` | `(text, options?) => void` | Typed user turn. By default the agent replies in text only, streamed as transcript text with no TTS. Pass `{ audio: true }` to have the agent speak the reply. Pair with [`useAgentMessages`](useAgentMessages.md) for a chat UI. |
| `sendUserActivity` | `() => void` | Signals that the user is typing. Briefly holds the agent back from speaking. |
| `interrupt` | `() => void` | Explicitly cut the agent off. |
| `startAudio` | `() => Promise<void>` | Unlock playback inside a user gesture if autoplay was blocked. |
| `setOutputVolume` | `(volume) => void` | Playback volume, `0..1`. |
| `setInputDevice` | `(deviceId) => Promise<void>` | Switch the microphone mid-call. Rejects with `device_change_failed` if the device cannot be activated, and switches back on a best-effort basis. No-op before the first start. |
| `setOutputDevice` | `(deviceId) => Promise<void>` | Route playback to another output device. `""` means the default. Rejects with `device_change_failed` where unsupported, which is common on mobile browsers. No-op before the first start. To pick a device before the call, pass `audio.outputDeviceId` in `startSession` overrides instead. |
| `session` | `AgentSession \| null` | The underlying session, for direct `.on(...)` event access. `null` before the first start. |

## Lifecycle details

- **Double-start safe.** If a session is already live, `startSession` resolves with its id instead of starting a second one; two concurrent calls (double-click) share one start.
- **Hangup-during-start safe.** Calling `endSession` while a start is still waiting on session creation, microphone permission, or the realtime connection marks the conversation ended and waits for that start to settle; a late connection is closed before the hook exposes it. A new `startSession` requested while that cleanup is in flight waits and then creates a fresh session. If another `endSession` cancels that queued restart, it rejects with an error whose `name` is `"AbortError"`.
- **Failure resets.** If `startSession` rejects without an intervening hangup (see [Errors](../errors.md)), `status` returns to `"idle"` and the hook is ready for another attempt:

  ```tsx
  try {
    await conversation.startSession({ sessionToken });
  } catch (error) {
    if (error instanceof FishAgentError && error.code === "mic_permission_denied") {
      showMicHelp();
    }
  }
  ```

- **Unmount ends the call.** No leaked microphones after navigation. Keep the component mounted for the whole call. If the page around it changes, lift it up or use the [provider](provider.md).
- The conversation-message senders (`sendUserMessage` etc.) are no-ops before the session connects; they don't queue.
