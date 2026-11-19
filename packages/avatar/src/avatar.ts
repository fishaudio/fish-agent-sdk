import { MOTION } from "./look.js";
import { drawOrb } from "./renderer.js";
import { agentAvatar, type AgentAvatarLook } from "./rule.js";

export type AvatarState = "idle" | "listening" | "speaking";

export interface AvatarOptions {
  /** The agent id. The same id always draws the same avatar. */
  id: string;
  /** Box size in CSS pixels. Eyes appear from 64. */
  size: number;
  /**
   * Keep the orb flowing. Off by default: the avatar is drawn once and costs
   * nothing afterwards. Animation pauses off screen and is ignored when the
   * user prefers reduced motion.
   */
  animated?: boolean;
  /** Call state. Only used when animated. */
  state?: AvatarState;
  /**
   * The agent's output level, 0–1, read every frame while speaking, for
   * example `() => session.getOutputVolume()`. Without it, speech is simulated.
   */
  getVolume?: () => number;
  /** Called after the first frame is painted. Not called when WebGL is unavailable. */
  onPaint?: () => void;
}

export interface AvatarHandle {
  /** Applies changed options. Unchanged ones are kept. */
  update(options: Partial<Omit<AvatarOptions, "onPaint">>): void;
  /** Stops drawing. The canvas keeps its last frame. */
  destroy(): void;
}

interface Mounted {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  options: AvatarOptions;
  look: AgentAvatarLook;
  px: number;
  visible: boolean;
  painted: boolean;
  // Motion state, eased toward the call state each frame
  clock: number;
  energy: number;
  listen: number;
  voice: number;
  voiceTarget: number;
  nextSyllable: number;
}

const MAX_DPR = 2;
const CACHE_LIMIT = 300;

/** Static frames by id, size and pixel ratio. Oldest entries go first. */
const cache = new Map<string, HTMLCanvasElement>();
const animated = new Set<Mounted>();
let frameId = 0;
let lastFrame = 0;
let time = 0;

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const isAnimated = (m: Mounted) => !!m.options.animated && !reducedMotion();

function paint(m: Mounted, source: CanvasImageSource | null) {
  if (source) {
    m.ctx.clearRect(0, 0, m.px, m.px);
    m.ctx.drawImage(source, 0, 0);
  }
  if (!m.painted) {
    m.painted = true;
    m.options.onPaint?.();
  }
}

function drawStatic(m: Mounted) {
  const key = `${m.look.id}\u0000${m.px}\u0000${m.look.eyes ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    paint(m, hit);
    return;
  }
  const frame = document.createElement("canvas");
  frame.width = frame.height = m.px;
  const ctx = frame.getContext("2d");
  if (!ctx || !drawOrb(ctx, m.px, { look: m.look, clock: 0, energy: 0, listen: 0, pulse: 0 })) return;
  cache.set(key, frame);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  paint(m, frame);
}

function step(m: Mounted, dt: number) {
  const { state = "idle", getVolume } = m.options;
  const speaking = state === "speaking";
  const listening = state === "listening";
  if (speaking && getVolume) {
    m.voiceTarget = Math.min(1, getVolume() * 7);
  } else if (!speaking) {
    m.voiceTarget = 0;
  } else if (time > m.nextSyllable) {
    // Syllables with short pauses, for when there is no real audio level
    const pause = Math.random() < 0.13;
    m.voiceTarget = pause ? 0 : 0.4 + Math.random() * 0.6;
    m.nextSyllable = time + (pause ? 0.3 + Math.random() * 0.5 : 0.08 + Math.random() * 0.15);
  }
  const ease = (rate: number) => 1 - Math.exp(-rate * dt);
  m.voice += (m.voiceTarget - m.voice) * ease(m.voiceTarget > m.voice ? 22 : 8);
  m.energy += ((speaking ? 0.4 + m.voice * 0.6 : 0) - m.energy) * ease(6);
  m.listen += ((listening ? 1 : 0) - m.listen) * ease(5);
  m.clock += dt * MOTION.speed * (1 + m.energy * MOTION.speakBoost);
}

function tick(now: number) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  time += dt;
  for (const m of animated) {
    if (!m.visible) continue;
    step(m, dt);
    const pulse =
      (m.options.state === "speaking" ? m.voice * MOTION.pulse : 0) +
      Math.sin(time * 1.4 + m.look.seed) * MOTION.breath +
      m.listen * 0.015;
    if (drawOrb(m.ctx, m.px, { look: m.look, clock: m.clock, energy: m.energy, listen: m.listen, pulse })) {
      paint(m, null);
    }
  }
  frameId = animated.size > 0 ? requestAnimationFrame(tick) : 0;
}

function startLoop() {
  if (frameId || typeof requestAnimationFrame !== "function") return;
  lastFrame = performance.now();
  frameId = requestAnimationFrame(tick);
}

function layout(m: Mounted) {
  const { size, id } = m.options;
  const dpr = Math.min(MAX_DPR, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
  m.px = Math.max(1, Math.round(size * dpr));
  m.look = agentAvatar(id, size);
  m.canvas.width = m.canvas.height = m.px;
  m.canvas.style.width = m.canvas.style.height = `${size}px`;
}

function render(m: Mounted) {
  if (isAnimated(m)) {
    animated.add(m);
    startLoop();
  } else {
    animated.delete(m);
    drawStatic(m);
  }
}

/**
 * Draws the agent's avatar into `canvas` and keeps it up to date. The canvas
 * is sized to `size` CSS pixels. When WebGL is unavailable the canvas stays
 * blank; show {@link avatarBackground} behind it as a fallback.
 */
export function mountAvatar(canvas: HTMLCanvasElement, options: AvatarOptions): AvatarHandle {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { update() {}, destroy() {} };
  const m: Mounted = {
    canvas,
    ctx,
    options: { ...options },
    look: agentAvatar(options.id, options.size),
    px: 0,
    visible: true,
    painted: false,
    clock: 0,
    energy: 0,
    listen: 0,
    voice: 0,
    voiceTarget: 0,
    nextSyllable: 0,
  };
  layout(m);
  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(([entry]) => {
          m.visible = entry?.isIntersecting ?? true;
        })
      : null;
  observer?.observe(canvas);
  render(m);

  return {
    update(next) {
      const before = m.options;
      m.options = { ...before, ...next };
      if (m.options.id !== before.id || m.options.size !== before.size) {
        layout(m);
        m.clock = 0;
        render(m);
      } else if (!!m.options.animated !== !!before.animated) {
        render(m);
      }
    },
    destroy() {
      animated.delete(m);
      observer?.disconnect();
    },
  };
}
