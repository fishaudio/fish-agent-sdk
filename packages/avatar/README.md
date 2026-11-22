# @fishaudio/agent-avatar

Generated avatars for [Fish Audio](https://fish.audio) voice agents. Any seed, such as an agent id or a template key, maps to one stable face: one of 18 full, rounded outlines in one of 13 restrained colours, with a slowly flowing painted body and white eyes. The same seed draws the same face everywhere, on the server and in the browser.

Avatars react to the call: connecting, listening, thinking, speaking (with the real output level), ended and error each have their own look. Motion is restrained, sized to the avatar, and off when the user prefers reduced motion.

## Installation

```bash
npm install @fishaudio/agent-avatar
```

React 18+ is an optional peer dependency.

## React

```tsx
import { AgentAvatar } from "@fishaudio/agent-avatar/react";

<AgentAvatar agentId={agent.id} size={40} />;
```

During a call, driven by the agent's voice:

```tsx
<AgentAvatar
  agentId={agent.id}
  size={96}
  animated
  state={state} // "connecting" | "listening" | "thinking" | "speaking" | "ended" | "error" | "idle"
  getVolume={() => session.getOutputVolume()}
/>
```

A short reaction after an event, such as a successful save:

```tsx
const avatar = useRef<AgentAvatarHandle>(null);
<AgentAvatar ref={avatar} agentId={agent.id} size={40} />;
avatar.current?.emote("happy"); // about 1.3 s, then back to the current state
```

| Prop | Default | Description |
|---|---|---|
| `agentId` | required | The seed. An agent id, or a stable template key so every agent made from one template shares its face. |
| `size` | `40` | Size in CSS pixels. What the avatar does depends on it: see the size matrix. |
| `animated` | `false` | Keep it alive: blinks, look-around, and from 48 px the flowing body. A still avatar is drawn once and costs nothing afterwards. |
| `state` | `"idle"` | Call state, see below. |
| `expression` | none | A lasting expression that replaces the state's own one. |
| `getVolume` | none | The agent's output level, 0–1, read every frame while speaking. Without it, speech is simulated. |
| `interactive` | `true` from 32 px | Look at the pointer on hover and press to 95%. Ignored below 32 px. |
| `variant` | `"slot"` | `"enlarged"` for dialogs, menus and sheets: a still image 1.25× the slot, centred, with the body about 78% of the slot. It still takes `size` in layout. |
| `reducedMotion` | system setting | Force reduced motion on or off. |
| `ref` | | `{ emote(expression, ms?) }`. |

Other props go to the wrapping `<span>`. Without an `aria-label` the avatar is decorative and hidden from assistive technology.

## Size matrix

Bigger avatars move more. With `animated` off, an avatar is still until the pointer is over it (from 32 px) or its state or expression changes.

| Size | Body | Eyes | Expressions | Pointer |
|---|---|---|---|---|
| 16–31 px (sidebars, bubbles, tables) | Still frame | Blink | Follow the state | None |
| 32–47 px (lists, pickers) | Still frame | Blink, slow look-around | Events play | Looks at the pointer, presses to 95% |
| 48–63 px (card headers) | Flowing, breathing | Blink, look-around | Events play | Same |
| 64 px and up (preview, calls, empty states) | Flowing, breathing, small bounces, squash while speaking | All, plus micro-saccades | Events play | Same |

Small avatars keep their own outline and get larger eyes (×1.45 up to 24 px, ×1.25 up to 48 px, ×1.15 above). Brush texture is full from 96 px and thins out below it: at 20 px about 15% grain and 30% brush.

## States and expressions

| State | Look |
|---|---|
| `idle` | Normal: blinks and looks around |
| `connecting` | The body shrinks away into three bars in the main colour, waving every 1.4 s |
| `listening` | Curious, looking at the user |
| `thinking` | Thinking: one eye narrowed, looking up |
| `speaking` | Follows `getVolume`: a light squash and lift |
| `ended` | Sleepy, slow breathing |
| `error` | Sad; the body fades 42% toward the background, the eyes do not |

Expressions: `normal`, `happy`, `curious`, `thinking`, `surprised`, `sad`, `sleepy`. `emote()` plays one for about 1.3 s and returns to the current state. Pressing never overshoots: the body goes to 95% and back on a critically damped spring.

## Without a framework

```js
import { mountAvatar } from "@fishaudio/agent-avatar";

const avatar = mountAvatar(document.querySelector("canvas"), { id: "agent-id", size: 64 });
avatar.update({ animated: true, state: "speaking", getVolume: () => session.getOutputVolume() });
avatar.emote("happy");
avatar.destroy();
```

`mountAvatar` takes the same options as the React component, with `id` for the seed.

## The rule

`avatarLook(seed)` returns the look without drawing anything. It has no DOM or WebGL dependency, so it also runs on a server.

- The seed is hashed with FNV-1a to an index from 0 to 99999.
- The outline is `index % 18` and the colour `index % 13`. 18 and 13 share no factor, so every outline meets every colour.
- Each outline is scaled to the same area as a circle and never reaches past 1.04 of its radius, so wide shapes do not look bigger. Each has its own eye anchor.
- The colour is spread to six: darker edge, main, light, highlight, and two neighbours turned ±20° in hue that drift through the flow.
- Eyes are white vertical ovals (1 : 1.76). Only a body brighter than 0.82 luminance gets dark eyes.
- The flow direction and its starting point come from the same index.

`AVATAR_SHAPES` and `AVATAR_COLORS` list the outlines and colours. `agentAvatar(id, size)` is the same look plus the resting eyes at a size. Changing the rule changes every agent's face; it only changes in a major version.

## Rendering and fallbacks

- All avatars on a page share one off-screen WebGL context. Each frame is copied into the avatar's own canvas, so avatars scroll and clip with the page natively. Still frames are cached by seed and size.
- Drawing stops when an avatar is off screen, inside a `display: none` container, or in a background tab. When nothing visible is animating, no frames run at all. A hidden avatar picks up where it would have been: state changes made meanwhile apply, and event expressions that ended meanwhile do not replay.
- With reduced motion, everything stops: no flow, blinks, breathing or bars. The state stays readable from the eye shapes, the bars and the error fade.
- Without WebGL the body is drawn flat in the same outline and colours, with the same eyes and states.
- `avatarSvg(seed, { size, state, expression, variant, idPrefix })` returns still SVG markup with the outline and eyes, for server rendering. Its gradient ids are page-global: when one seed can appear more than once on a page, give each copy its own `idPrefix`, or a copy inside a hidden container can break the others. The React component renders it on the server and until the first canvas frame, so an avatar never flashes empty, and gives each instance its own ids.
- `avatarBackground(look)` returns a CSS gradient in the avatar's colours, for places that can only take a background.

## Demo

```bash
pnpm --filter @fishaudio/agent-avatar demo
```

Open http://localhost:5198. Add `?theme=dark` or `?reduce=1` to the URL to force a theme or reduced motion.

## License

MIT
