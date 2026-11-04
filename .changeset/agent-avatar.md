---
"@fishaudio/agent-avatar": minor
---

New package. `avatarLook(seed)` maps any seed, such as an agent id or a template key, to a stable face: one of 18 rounded outlines in one of 13 colours. `mountAvatar` draws it with a flowing painted body and white eyes, with seven call states, seven expressions and motion layered by size; all avatars on a page share one WebGL context. `@fishaudio/agent-avatar/react` exports `<AgentAvatar>`, which renders a still SVG on the server and before the first frame. `avatarSvg` returns that SVG on its own.
