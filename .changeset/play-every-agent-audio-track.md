---
"@fishaudio/agent-client": patch
---

Play every agent audio track. Agents with background ambience publish it as a second track, and it used to replace the agent's speech in the one playback element, so only the ambience was heard. Each track now gets its own element; volume and output device apply to all of them. Output level and frequency data follow the agent's speech only.
