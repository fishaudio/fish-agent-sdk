// Face and body motion. No DOM: it turns state, expression, pointer and time
// into a pose that the canvas and SVG renderers draw. All motion is close to
// critically damped (damping ratio about 0.9), so things arrive without wobble.

import type { AvatarLook } from "./rule.js";
import { avatarShape } from "./shapes.js";
import { eyeScaleFor } from "./rule.js";

export type AvatarState = "idle" | "connecting" | "speaking" | "listening" | "thinking" | "ended" | "error";
export type AvatarExpression = "normal" | "happy" | "curious" | "thinking" | "surprised" | "sad" | "sleepy";

export const AVATAR_STATES: ReadonlyArray<AvatarState> = [
  "idle",
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "ended",
  "error",
];
export const AVATAR_EXPRESSIONS: ReadonlyArray<AvatarExpression> = [
  "normal",
  "happy",
  "curious",
  "thinking",
  "surprised",
  "sad",
  "sleepy",
];

/** Default length of an event expression, in milliseconds. */
export const EMOTE_MS = 1300;

/**
 * What an avatar of a given size may do. Bigger avatars move more.
 * - 16–31: body frozen; eyes blink; expressions follow the state.
 * - 32–47: plus a slow look-around, looking at the pointer, and a light press.
 * - 48–63: plus the live flow and breathing.
 * - 64 and up: plus eye micro-saccades, small bounces and speaking squash.
 */
export interface SizeTier {
  liveFlow: boolean;
  lookAround: boolean;
  pointer: boolean;
  breathe: boolean;
  bounce: boolean;
  saccade: boolean;
}

export function sizeTier(size: number): SizeTier {
  return {
    liveFlow: size >= 48,
    lookAround: size >= 32,
    pointer: size >= 32,
    breathe: size >= 48,
    bounce: size >= 64,
    saccade: size >= 64,
  };
}

type Glyph = "oval" | "happy" | "closed";
const GLYPHS: ReadonlyArray<Glyph> = ["oval", "happy", "closed"];

interface EyeSpec {
  t: Glyph;
  s: number;
  open: number;
  roll: number;
}
const E_ = (t: Glyph = "oval", s = 1, open = 1, roll = 0): EyeSpec => ({ t, s, open, roll });

interface ExpressionSpec {
  L: EyeSpec;
  R: EyeSpec;
  dy?: number;
  tilt?: number;
  look?: readonly [number, number];
  act?: "bounce" | "stretch" | "shake";
  zz?: boolean;
}

/** The seven product expressions. Only the eyes and very small body moves change. */
export const EXPRESSIONS: Record<AvatarExpression, ExpressionSpec> = {
  normal: { L: E_(), R: E_() },
  happy: { L: E_("happy"), R: E_("happy"), act: "bounce" },
  surprised: { L: E_("oval", 1.15, 1.06), R: E_("oval", 1.15, 1.06), dy: -0.015, act: "stretch" },
  curious: { L: E_("oval", 0.94, 0.92), R: E_("oval", 1.08, 1.02), tilt: -5, look: [0.4, -0.3] },
  sleepy: { L: E_("closed"), R: E_("closed"), dy: 0.04, look: [0, 0.3], zz: true },
  thinking: { L: E_("oval", 0.96, 0.6, -3), R: E_("oval", 1, 0.92), look: [0.45, -0.45], tilt: 2 },
  sad: { L: E_("oval", 0.94, 0.9, 10), R: E_("oval", 0.94, 0.9, 10), dy: 0.04, look: [-0.15, 0.4], act: "shake" },
};

/** The expression each call state rests on. */
export function stateExpression(state: AvatarState): AvatarExpression {
  switch (state) {
    case "listening":
      return "curious";
    case "thinking":
      return "thinking";
    case "ended":
      return "sleepy";
    case "error":
      return "sad";
    default:
      return "normal";
  }
}

/** Resting gaze: straight ahead, slightly down. Sometimes to either side. */
const LOOKS: ReadonlyArray<readonly [number, number]> = [
  [0, 0.06],
  [0, 0.06],
  [0, 0.06],
  [-0.3, 0.05],
  [0.3, 0.05],
  [-0.15, -0.15],
  [0.15, -0.12],
];

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

class Spring {
  x: number;
  t: number;
  v = 0;
  constructor(x: number, readonly k: number, readonly d: number) {
    this.x = x;
    this.t = x;
  }
  step(dt: number) {
    const a = -this.k * (this.x - this.t) - this.d * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
  }
  snap() {
    this.x = this.t;
    this.v = 0;
  }
  get settled() {
    return Math.abs(this.x - this.t) < 1e-3 && Math.abs(this.v) < 1e-3;
  }
}

export interface EyePose {
  cx: number;
  cy: number;
  /** Degrees. */
  th: number;
  fz: number;
  roll: number;
  rr: number;
  /** Combined openness for the oval glyph. */
  open: number;
  /** Blink squash, 0–1 (1 = fully open). */
  blink: number;
  glyphs: Record<Glyph, number>;
}

export interface Pose {
  /** Body transform in outline units: translate, rotate (degrees), scale. */
  tx: number;
  ty: number;
  rot: number;
  sx: number;
  sy: number;
  /** The body is shrunk away while connecting. */
  bodyHidden: boolean;
  /** 0 = full colour, 1 = faded 42% (error). */
  dim: number;
  eyes: [EyePose, EyePose];
  eyesOpacity: number;
  /** Connecting bars: opacity and heights. */
  bars: number;
  barHeights: [number, number, number];
  /** Sleepy "z", 0–1, and its phase. */
  zz: number;
  zzPhase: number;
  /** Flow inputs for the shader. */
  clock: number;
  energy: number;
  listen: number;
}

export interface FaceOptions {
  size: number;
  state: AvatarState;
  expression?: AvatarExpression;
  /** Run time-based motion: blinks, look-around, flow. */
  animated: boolean;
  reducedMotion: boolean;
  interactive: boolean;
  getVolume?: () => number;
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Flow clock speed and speaking boost, as on the reference orb (drift at 60%). */
const FLOW_SPEED = 2.65 * 0.6;
const SPEAK_BOOST = 0.55;

export class Face {
  private s = {
    // press uses this one: critically damped, so 95% and back never overshoots
    scale: new Spring(1, 180, 27),
    sx: new Spring(1, 220, 27),
    sy: new Spring(1, 220, 27),
    y: new Spring(0, 200, 25),
    x: new Spring(0, 260, 29),
    rot: new Spring(0, 140, 21),
    lx: new Spring(0, 90, 17),
    ly: new Spring(0.06, 90, 17),
    egap: new Spring(0.2, 240, 28),
    edy: new Spring(0, 240, 28),
    eop: new Spring(1, 200, 25),
    dot: new Spring(0, 220, 27),
    zz: new Spring(0, 120, 20),
    dim: new Spring(0, 160, 24),
  };
  private eyeS = [0, 1].map(() => ({
    s: new Spring(1, 240, 28),
    open: new Spring(1, 300, 31),
    roll: new Spring(0, 200, 25),
    g: Object.fromEntries(GLYPHS.map((k) => [k, new Spring(k === "oval" ? 1 : 0, 260, 30)])) as Record<
      Glyph,
      Spring
    >,
  }));

  private T = 0;
  private nextBlink = rnd(0.5, 3);
  private blinkAt = -9;
  private double = false;
  private nextLook = rnd(1, 3);
  private nextSaccade = 0;
  private saccade: [number, number] = [0, 0];
  private voice = { v: 0, target: 0, next: 0 };
  private timers: Array<{ at: number; fn: () => void }> = [];
  private playUntil = 0;
  private exLook: readonly [number, number] | null = null;
  private hold = false;
  private exprName: AvatarExpression = "normal";
  private breathPhase = Math.random() * 6.28;

  clock = 0;
  energy = 0;
  listen = 0;
  hover: [number, number] | null = null;
  pressed = false;

  constructor(
    private look: AvatarLook,
    private opts: FaceOptions,
  ) {
    this.applyState(opts.state, null);
    this.snap();
  }

  setLook(look: AvatarLook) {
    this.look = look;
  }

  /** Applies changed options. State and expression changes animate unless reduced motion is on. */
  update(next: FaceOptions) {
    const prev = this.opts;
    this.opts = next;
    if (next.state !== prev.state) this.applyState(next.state, prev.state);
    else if (next.expression !== prev.expression && this.T >= this.playUntil) this.expr(this.baseExpr());
    if (next.reducedMotion) this.snap();
  }

  private baseExpr(): AvatarExpression {
    return this.opts.expression ?? stateExpression(this.opts.state);
  }

  private baseScale() {
    return this.opts.state === "connecting" ? 0.2 : 1;
  }

  private after(seconds: number, fn: () => void) {
    this.timers.push({ at: this.T + seconds, fn });
  }

  private expr(name: AvatarExpression, act = true) {
    const E = EXPRESSIONS[name] ?? EXPRESSIONS.normal;
    this.exprName = name;
    const s = this.s;
    [E.L, E.R].forEach((e, i) => {
      const S = this.eyeS[i]!;
      S.s.t = e.s;
      S.open.t = e.open;
      S.roll.t = e.roll;
      for (const k of GLYPHS) S.g[k].t = k === e.t ? 1 : 0;
    });
    s.egap.t = 0.2;
    s.edy.t = E.dy ?? 0;
    s.rot.t = E.tilt ?? 0;
    s.zz.t = E.zz ? 1 : 0;
    this.exLook = E.look ?? (this.opts.state === "listening" ? [0, -0.1] : null);
    if (!act || this.opts.reducedMotion || !this.opts.animated || !sizeTier(this.opts.size).bounce) return;
    if (E.act === "bounce") this.bounce(0.6);
    if (E.act === "stretch") {
      s.sy.v += 1.6;
      s.sx.v -= 1.2;
      s.y.v -= 1.5;
    }
    if (E.act === "shake") for (let i = 0; i < 4; i++) this.after(0.08 * i, () => (s.x.v += (i % 2 ? -1 : 1) * 12));
  }

  private bounce(p: number) {
    this.s.y.v -= 3 * p;
    this.s.sx.v -= 1.1 * p;
    this.s.sy.v += 1.1 * p;
  }

  private applyState(st: AvatarState, prev: AvatarState | null) {
    const s = this.s;
    this.timers = [];
    this.playUntil = 0;
    s.scale.t = this.pressed ? 0.95 * this.baseScale() : this.baseScale();
    s.eop.t = st === "connecting" ? 0 : 1;
    s.dot.t = st === "connecting" ? 1 : 0;
    s.dim.t = st === "error" ? 1 : 0;
    this.hold = st === "listening" || st === "thinking" || st === "ended" || st === "error";
    this.expr(this.baseExpr());
    if (st === "speaking" && prev === "connecting") this.emote("happy", 900);
    if (st === "idle" && prev === "speaking") this.emote("happy", 1400);
  }

  /** Plays an event expression, then returns to the current state's expression. */
  emote(name: AvatarExpression, ms = EMOTE_MS) {
    this.expr(name);
    this.playUntil = this.T + ms / 1000;
    this.timers = this.timers.filter((t) => t.fn !== this.restore);
    this.after(ms / 1000, this.restore);
  }

  private restore = () => {
    this.playUntil = 0;
    this.expr(this.baseExpr(), false);
  };

  press(down: boolean) {
    if (this.opts.state === "connecting") return;
    this.pressed = down;
    this.s.scale.t = down ? 0.95 * this.baseScale() : this.baseScale();
  }

  private springs(): Spring[] {
    const out: Spring[] = Object.values(this.s);
    for (const S of this.eyeS) out.push(S.s, S.open, S.roll, ...Object.values(S.g));
    return out;
  }

  snap() {
    for (const sp of this.springs()) sp.snap();
    this.lookTarget();
    this.s.lx.snap();
    this.s.ly.snap();
  }

  /** True while something is still moving or scheduled, so frames are needed even when not animated. */
  get busy(): boolean {
    if (this.timers.length || this.hover || this.pressed) return true;
    if (this.T - this.blinkAt < 0.5) return true;
    if (this.voice.v > 1e-3) return true;
    return this.springs().some((sp) => !sp.settled);
  }

  private lookTarget() {
    const { lx, ly } = this.s;
    const set = (x: number, y: number) => {
      lx.t = x;
      ly.t = y;
    };
    const tier = sizeTier(this.opts.size);
    if (this.pressed) set(0, 0.02);
    else if (this.hover && tier.pointer && this.opts.interactive && !this.opts.reducedMotion) set(...this.hover);
    else if (this.exLook) set(...this.exLook);
    else if (!this.opts.animated || this.opts.reducedMotion || !tier.lookAround) set(0, 0.06);
    else if (!this.hold && this.T > this.nextLook) {
      set(...LOOKS[Math.floor(Math.random() * LOOKS.length)]!);
      this.nextLook = this.T + rnd(2.5, 5);
    }
  }

  /** Advances time by `dt` seconds and returns the pose to draw. */
  step(dt: number): Pose {
    const o = this.opts;
    const tier = sizeTier(o.size);
    const still = o.reducedMotion;
    const moving = o.animated && !still;
    this.T += dt;
    const T = this.T;

    const due = this.timers.filter((t) => t.at <= T);
    if (due.length) {
      this.timers = this.timers.filter((t) => t.at > T);
      for (const t of due) t.fn();
    }

    // Voice: the real output level when given, otherwise simulated syllables.
    const v = this.voice;
    if (o.state === "speaking" && !still) {
      if (o.getVolume) v.target = clamp(o.getVolume() * 7, 0, 1);
      else if (T > v.next) {
        const pause = Math.random() < 0.13;
        v.target = pause ? 0 : 0.4 + Math.random() * 0.6;
        v.next = T + (pause ? rnd(0.3, 0.8) : rnd(0.08, 0.23));
      }
    } else v.target = 0;
    v.v += (v.target - v.v) * (1 - Math.exp(-(v.target > v.v ? 22 : 8) * dt));
    if (still) v.v = v.target;

    this.lookTarget();
    if (moving && tier.saccade && T > this.nextSaccade) {
      this.saccade = [rnd(-0.025, 0.025), rnd(-0.02, 0.02)];
      this.nextSaccade = T + rnd(0.8, 1.8);
    }

    const canBlink = this.eyeS.every((S) => S.g.oval.t > 0.5);
    if (T > this.nextBlink) {
      if (canBlink && moving) {
        this.blinkAt = T;
        this.double = Math.random() < 0.2;
      }
      this.nextBlink = T + rnd(2, 5.5);
    }
    const bt = T - this.blinkAt;
    const bl = (t: number) => (t < 0 || t > 0.2 ? 1 : 1 - Math.sin((Math.PI * t) / 0.2) * 0.94);
    const open = Math.min(bl(bt), this.double ? bl(bt - 0.26) : 1);

    const s = this.s;
    const squash = o.state === "speaking" && tier.bounce && moving;
    s.sy.t = squash ? 1 - v.v * 0.035 : 1;
    s.sx.t = squash ? 1 + v.v * 0.025 : 1;
    s.y.t = squash ? -v.v * 0.025 : 0;

    if (still) this.snap();
    else for (let i = 0; i < 2; i++) for (const sp of this.springs()) sp.step(dt / 2);

    // Flow inputs: speaking energy and listening glow ease in.
    const k = 1 - Math.exp(-6 * dt);
    this.energy += ((o.state === "speaking" ? 0.4 + v.v * 0.6 : 0) - this.energy) * (still ? 1 : k);
    this.listen += ((o.state === "listening" ? 1 : 0) - this.listen) * (still ? 1 : 1 - Math.exp(-5 * dt));
    if (moving && tier.liveFlow) this.clock += dt * FLOW_SPEED * (1 + this.energy * SPEAK_BOOST);

    const sac = moving && tier.saccade ? this.saccade : [0, 0];
    const lx = s.lx.x + sac[0]!;
    const ly = s.ly.x + sac[1]!;
    const sleepy = o.state === "ended" || this.exprName === "sleepy";
    const breathe =
      moving && tier.breathe
        ? sleepy
          ? 1 + Math.sin(T * 1.6) * 0.015
          : 1 + Math.sin(T * 2.2 + this.breathPhase) * 0.006
        : 1;
    const sc = s.scale.x * breathe;
    // Frozen sizes keep the body still: only the press and connecting scale apply.
    const bodyMoves = moving && tier.liveFlow;
    const pose: Pose = {
      tx: bodyMoves ? s.x.x * 0.04 + lx * 0.03 : 0,
      ty: bodyMoves ? s.y.x * 0.1 + ly * 0.02 : 0,
      rot: bodyMoves ? s.rot.x + lx * 4 : 0,
      sx: bodyMoves ? sc * s.sx.x : s.scale.x,
      sy: bodyMoves ? sc * s.sy.x : s.scale.x,
      bodyHidden: o.state === "connecting" && s.scale.x < 0.45,
      dim: clamp(s.dim.x, 0, 1),
      eyes: [this.eye(0, lx, ly, open, v.v), this.eye(1, lx, ly, open, v.v)],
      eyesOpacity: clamp(s.eop.x, 0, 1),
      bars: clamp(s.dot.x, 0, 1),
      barHeights: [0, 1, 2].map(
        (i) => 0.34 + 0.3 * (0.5 + 0.5 * Math.sin((2 * Math.PI * (moving ? T : 0)) / 1.4 - i * 1.4)),
      ) as [number, number, number],
      zz: clamp(s.zz.x, 0, 1),
      zzPhase: T * 0.5,
      clock: this.clock,
      energy: this.energy,
      listen: this.listen,
    };
    return pose;
  }

  /** Eyes sit on an invisible sphere: turning the head widens the near eye and narrows the far one. */
  private eye(i: number, lx: number, ly: number, blink: number, voice: number): EyePose {
    const S = this.eyeS[i]!;
    const [ax, ay, es0] = avatarShape(this.look.shape).eye;
    const es = es0 * eyeScaleFor(this.opts.size);
    const yaw = lx * 0.7;
    const pitch = ly * 0.6;
    const R = 0.92;
    const base = 0.085 * es;
    const ox = (ax - 0.12) * 0.8;
    const oy = ay + 0.1 + this.s.edy.x + (this.opts.state === "speaking" ? -voice * 0.04 : 0);
    const g = this.s.egap.x * es;
    const sx = i ? 1 : -1;
    const x = Math.sin(g * sx);
    const y = oy;
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
    const x1 = x * Math.cos(yaw) + z * Math.sin(yaw);
    const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
    const y2 = y * Math.cos(pitch) + z1 * Math.sin(pitch);
    const z2 = -y * Math.sin(pitch) + z1 * Math.cos(pitch);
    const rr = base * S.s.x;
    return {
      cx: ox + x1 * R,
      cy: y2 * R + (1 - blink) * rr * 0.5,
      th: (Math.atan2(y2, x1) * 180) / Math.PI,
      fz: clamp(z2, 0.28, 1),
      roll: S.roll.x * -sx,
      rr,
      open: S.open.x * blink,
      blink,
      glyphs: { oval: S.g.oval.x, happy: S.g.happy.x, closed: S.g.closed.x },
    };
  }
}
