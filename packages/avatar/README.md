# @fishaudio/agent-avatar

Generated avatars for [Fish Audio](https://fish.audio) voice agents. Each agent id maps to one stable look: a painted, flowing orb in its own colours. Avatars 64 px and larger also get eyes. The same id draws the same avatar everywhere.

Avatars are static by default. A static avatar is drawn once and costs nothing afterwards. Turn on `animated` where the agent should feel alive, such as an agent's page or a call screen.

## Installation

```bash
npm install @fishaudio/agent-avatar
```

## React

```tsx
import { AgentAvatar } from "@fishaudio/agent-avatar/react";

<AgentAvatar agentId={agent.id} size={40} />;
```

Animate it during a call, driven by the agent's voice:

```tsx
<AgentAvatar
  agentId={agent.id}
  size={96}
  animated
  state={isSpeaking ? "speaking" : "listening"}
  getVolume={() => session.getOutputVolume()}
/>
```

| Prop | Default | Description |
|---|---|---|
| `agentId` | required | The agent id. |
| `size` | `40` | Size in CSS pixels. Eyes appear from 64. |
| `animated` | `false` | Keep the orb flowing. Pauses off screen. Ignored when the user prefers reduced motion. |
| `state` | `"idle"` | `"idle"`, `"listening"` or `"speaking"`. Only used when animated. |
| `getVolume` | none | The agent's output level, 0–1, read every frame while speaking. Without it, speech is simulated. |

Other props go to the underlying `<canvas>`. Without an `aria-label` the avatar is decorative and hidden from assistive technology.

React 18+ is an optional peer dependency.

## Without a framework

```js
import { mountAvatar } from "@fishaudio/agent-avatar";

const avatar = mountAvatar(document.querySelector("canvas"), { id: "agent-id", size: 64 });
avatar.update({ animated: true, state: "speaking" });
avatar.destroy();
```

## The rule

`agentAvatar(id, size)` returns the look without drawing anything: the palette, flow direction, animation seed and eyes. It has no DOM or WebGL dependency, so it also runs on a server.

- The id is hashed with FNV-1a to an index from 0 to 99999.
- The hue steps by the golden ratio along weighted bands. Cyan, blue, violet and pink are common. Amber and green are rarer. Yellow-green is never used.
- The index picks one of three lightness tiers, so neighbouring avatars differ in depth.
- All six palette colours stay close to the main hue.
- Eyes are bars, dots or ovals, with a fixed gaze. About one in four smiles.

Changing the rule changes every agent's face. It only changes in a major version.

## Rendering

All avatars on a page share one off-screen WebGL context. Browsers allow only a few live contexts, so avatars never create their own. Each frame is copied into the avatar's own canvas. Static frames are cached by id and size.

Where WebGL is unavailable, the canvas stays blank. The React component shows a gradient in the avatar's colours instead. `avatarBackground(look)` returns that gradient for server rendering or your own markup.

## Demo

```bash
pnpm --filter @fishaudio/agent-avatar demo
```

## License

MIT
