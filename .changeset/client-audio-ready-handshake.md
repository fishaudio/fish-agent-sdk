---
"@fishaudio/agent-client": minor
---

Sessions now report playback readiness to the agent. Right after joining, the SDK announces that it will report when it can play audio, and once the agent's audio track is attached and the browser has allowed playback it reports ready. Where the runtime supports this handshake, the agent holds its opening line until then (bounded, about 1.5 seconds), so the first words are not lost on iOS, during a Bluetooth route switch, or while playback is still unlocking. Elsewhere the opening line plays right away, as before. Nothing to call. Under an autoplay block the report goes out when `session.startAudio()` unlocks playback, so keep calling it from a user gesture when playback was blocked.

The agent's ready signal (its pipeline is live and the opening line is queued) is now the primary "agent joined" signal for the 15 s join watchdog and for releasing messages typed before the agent arrived. The agent's framework state stays as the fallback, so older runtimes behave as before.
