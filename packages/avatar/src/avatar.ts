import { ENLARGED_CANVAS, ENLARGED_HALF, SLOT_HALF, drawPose } from "./draw.js";
import { EMOTE_MS, Face, sizeTier, type AvatarExpression, type AvatarState, type FaceOptions } from "./face.js";
import { avatarLook, type AvatarLook } from "./rule.js";

export type { AvatarExpression, AvatarState } from "./face.js";

/** `slot` fills its box. `enlarged` is a still image for dialogs, menus and sheets: 1.25× the slot, centred, body about 78% of the slot. */
export type AvatarVariant = "slot" | "enlarged";

export interface AvatarOptions {
  /** The seed: an agent id or a stable template key. The same seed always draws the same avatar. */
  id: string;
  /** Box size in CSS pixels. What the avatar does depends on it: see the size matrix in the README. */
  size: number;
  /**
   * Keep the avatar alive: blinks, look-around, and from 48 px the flowing
   * body. Off by default: a still avatar is drawn once and costs nothing
   * afterwards. Pauses off screen and in background tabs.
   */
  animated?: boolean;
  /** Call state. */
  state?: AvatarState;
  /** A lasting expression that replaces the state's own one. */
  expression?: AvatarExpression;
  /**
   * The agent's output level, 0–1, read every frame while speaking, for
   * example `() => session.getOutputVolume()`. Without it, speech is simulated.
   */
  getVolume?: () => number;
  /** From 32 px: look at the pointer on hover and press to 95%. Defaults to true from 32 px. */
  interactive?: boolean;
  /** Defaults to `slot`. `enlarged` is always still. */
  variant?: AvatarVariant;
  /** Force reduced motion on or off. Defaults to the user's `prefers-reduced-motion` setting. */
  reducedMotion?: boolean;
  /** Called after the first frame is painted. */
  onPaint?: () => void;
  /**
   * Called when the avatar stops needing frames: not animated, and every
   * hover, press, emote and transition has settled. A good moment to swap
   * the canvas for a still image (see {@link acquireAvatarImage}).
   */
  onSettle?: () => void;
}

export interface AvatarHandle {
  /** Applies changed options. Unchanged ones are kept. */
  update(options: Partial<Omit<AvatarOptions, "onPaint" | "onSettle">>): void;
  /** Plays an event expression for `ms` (about 1.3 s by default), then returns to the current state. */
  emote(expression: AvatarExpression, ms?: number): void;
  /** Stops drawing. The canvas keeps its last frame. */
  destroy(): void;
}

interface Mounted {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  options: AvatarOptions;
  look: AvatarLook;
  face: Face;
  px: number;
  half: number;
  /** In the viewport (IntersectionObserver). */
  visible: boolean;
  /** Laid out with a size: false while it or an ancestor is display: none (ResizeObserver). */
  sized: boolean;
  /** When the avatar left the frame loop because it could not be seen, so hidden time can be skipped on return. */
  hiddenAt: number | null;
  painted: boolean;
}

const MAX_DPR = 2;

const mounted = new Set<Mounted>();
const active = new Set<Mounted>();
let frameId = 0;
let lastFrame = 0;

const reduceQuery =
  typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
reduceQuery?.addEventListener?.("change", () => {
  for (const m of mounted) {
    m.face.update(faceOptions(m.options));
    wake(m);
  }
});

const systemReduced = () => !!reduceQuery?.matches;

function faceOptions(o: AvatarOptions): FaceOptions {
  const enlarged = o.variant === "enlarged";
  return {
    size: o.size,
    state: o.state ?? "idle",
    expression: o.expression,
    animated: !!o.animated && !enlarged,
    reducedMotion: o.reducedMotion ?? systemReduced(),
    interactive: (o.interactive ?? o.size >= 32) && !enlarged,
    getVolume: o.getVolume,
  };
}

const pageHidden = () => typeof document !== "undefined" && document.hidden === true;

/** Whether drawing it would show anything: on screen, laid out, and the tab in front. */
const shown = (m: Mounted) => m.visible && m.sized && !pageHidden();

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!pageHidden()) for (const m of mounted) wake(m);
  });
}

/** Time-based motion keeps running (blinks, flow); otherwise frames stop once everything settles. */
const runs = (m: Mounted) => {
  const f = faceOptions(m.options);
  return f.animated && !f.reducedMotion;
};

function paint(m: Mounted, dt: number) {
  const pose = m.face.step(dt);
  const f = faceOptions(m.options);
  drawPose(
    { ctx: m.ctx, px: m.px, half: m.half, size: m.options.size, live: f.animated && !f.reducedMotion && sizeTier(m.options.size).liveFlow },
    m.look,
    pose,
  );
  if (!m.painted) {
    m.painted = true;
    m.options.onPaint?.();
  }
}

function tick(now: number) {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  for (const m of active) {
    // Hidden avatars leave the loop; wake() brings them back when they can be seen again.
    if (!shown(m)) {
      active.delete(m);
      m.hiddenAt ??= now;
      continue;
    }
    paint(m, dt);
    if (!runs(m) && !m.face.busy) {
      active.delete(m);
      m.options.onSettle?.();
    }
  }
  frameId = active.size > 0 ? requestAnimationFrame(tick) : 0;
}

function wake(m: Mounted) {
  if (!mounted.has(m)) return;
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  if (!shown(m)) {
    m.hiddenAt ??= now;
    return;
  }
  if (m.hiddenAt !== null) {
    // Time passed while hidden: finish what would have finished, without replaying it.
    m.face.fastForward((now - m.hiddenAt) / 1000);
    m.hiddenAt = null;
  }
  active.add(m);
  if (frameId || typeof requestAnimationFrame !== "function") return;
  lastFrame = performance.now();
  frameId = requestAnimationFrame(tick);
}

function layout(m: Mounted) {
  const { size, id, variant } = m.options;
  const enlarged = variant === "enlarged";
  const css = enlarged ? size * ENLARGED_CANVAS : size;
  const dpr = Math.min(MAX_DPR, (typeof devicePixelRatio === "number" && devicePixelRatio) || 1);
  m.px = Math.max(1, Math.round(css * dpr));
  m.half = enlarged ? ENLARGED_HALF : SLOT_HALF;
  if (m.look.id !== id) {
    m.look = avatarLook(id);
    m.face.setLook(m.look);
  }
  m.canvas.width = m.canvas.height = m.px;
  m.canvas.style.width = m.canvas.style.height = `${css}px`;
  m.canvas.style.margin = enlarged ? `${-(css - size) / 2}px` : "";
}

/**
 * Draws the avatar into `canvas` and keeps it up to date. The canvas is sized
 * to `size` CSS pixels (1.25× for `enlarged`, with a negative margin so it
 * still takes `size` in layout). Every avatar on the page shares one WebGL
 * context; without WebGL a flat body in the same outline and colours is
 * drawn instead, with the same eyes.
 */
export function mountAvatar(canvas: HTMLCanvasElement, options: AvatarOptions): AvatarHandle {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { update() {}, emote() {}, destroy() {} };
  const look = avatarLook(options.id);
  const m: Mounted = {
    canvas,
    ctx,
    options: { ...options },
    look,
    face: new Face(look, faceOptions(options)),
    px: 0,
    half: SLOT_HALF,
    visible: true,
    sized: true,
    hiddenAt: null,
    painted: false,
  };
  layout(m);
  mounted.add(m);

  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver(([entry]) => {
          m.visible = entry?.isIntersecting ?? true;
          if (m.visible) wake(m);
        })
      : null;
  observer?.observe(canvas);
  // display: none on the canvas or an ancestor gives it a zero size.
  const resizer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(([entry]) => {
          const box = entry?.contentRect;
          m.sized = !box || (box.width > 0 && box.height > 0);
          if (m.sized) wake(m);
        })
      : null;
  resizer?.observe(canvas);

  const pointer = () => {
    const f = faceOptions(m.options);
    return f.interactive && !f.reducedMotion && sizeTier(m.options.size).pointer;
  };
  const onMove = (e: PointerEvent) => {
    if (!pointer()) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width) return;
    const c = (v: number) => Math.max(-1, Math.min(1, v));
    m.face.hover = [
      c((e.clientX - r.left - r.width / 2) / (r.width / 2)) * 0.55,
      c((e.clientY - r.top - r.height / 2) / (r.height / 2)) * 0.5,
    ];
    wake(m);
  };
  const onLeave = () => {
    m.face.hover = null;
    m.face.press(false);
    wake(m);
  };
  const onDown = () => {
    if (!pointer()) return;
    m.face.press(true);
    wake(m);
  };
  const onUp = () => {
    m.face.press(false);
    wake(m);
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerenter", onMove);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  paint(m, 0);
  // One pass through the loop even when still, so onSettle reports once things are at rest.
  wake(m);

  return {
    update(next) {
      const before = m.options;
      m.options = { ...before, ...next };
      if (m.options.id !== before.id || m.options.size !== before.size || m.options.variant !== before.variant) {
        layout(m);
      }
      m.face.update(faceOptions(m.options));
      wake(m);
    },
    emote(expression, ms = EMOTE_MS) {
      if (m.options.variant === "enlarged") return;
      m.face.emote(expression, ms);
      wake(m);
    },
    destroy() {
      active.delete(m);
      mounted.delete(m);
      observer?.disconnect();
      resizer?.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerenter", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    },
  };
}
