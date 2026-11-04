// Draws a pose into a 2D canvas: the body (live WebGL, a cached frozen frame,
// or a flat 2D fallback), then eyes, connecting bars and the sleepy "z".
import type { EyePose, Pose } from "./face.js";
import { drawBody } from "./renderer.js";
import type { AvatarLook } from "./rule.js";
import { avatarShape } from "./shapes.js";

/** Half the drawn box in outline units, for a normal slot. */
export const SLOT_HALF = 1.12;
/** An enlarged avatar's canvas is 1.25× its slot, with the body about 78% of the slot. */
export const ENLARGED_CANVAS = 1.25;
export const ENLARGED_BODY = 0.78;
/** Half box in outline units for an enlarged avatar (the outline's equal-area circle has radius 0.92). */
export const ENLARGED_HALF = (ENLARGED_CANVAS * 1.84) / (2 * ENLARGED_BODY);
/** The body is faded this much toward the background in the error state. */
export const ERROR_FADE = 0.42;

const MAX_CACHE = 300;
const frozen = new Map<string, HTMLCanvasElement | null>();

const hasPath2D = () => typeof Path2D === "function";
const paths = new Map<number, Path2D>();
function shapePath(index: number): Path2D | null {
  if (!hasPath2D()) return null;
  let p = paths.get(index);
  if (!p) {
    p = new Path2D(avatarShape(index).path);
    paths.set(index, p);
  }
  return p;
}

/** A still frame of the body (no motion), cached by seed, size and pixel size. Null without WebGL. */
function frozenBody(look: AvatarLook, size: number, px: number, half: number): HTMLCanvasElement | null {
  const key = `${look.id}\u0000${size}\u0000${px}\u0000${half}`;
  if (frozen.has(key)) {
    const hit = frozen.get(key)!;
    frozen.delete(key);
    frozen.set(key, hit);
    return hit;
  }
  const c = document.createElement("canvas");
  c.width = c.height = px;
  const ctx = c.getContext("2d");
  const ok =
    !!ctx &&
    drawBody(ctx, px, 0, 0, { look, size, half, tx: 0, ty: 0, rot: 0, sx: 1, sy: 1, clock: 0, energy: 0, listen: 0 });
  const value = ok ? c : null;
  frozen.set(key, value);
  if (frozen.size > MAX_CACHE) frozen.delete(frozen.keys().next().value!);
  return value;
}

function flatBody(ctx: CanvasRenderingContext2D, look: AvatarLook) {
  const path = shapePath(look.shape);
  if (!path) return;
  const [edge, main, light] = look.palette;
  const a = ctx.createRadialGradient(-0.36, -0.44, 0, -0.36, -0.44, 1.9);
  a.addColorStop(0, light);
  a.addColorStop(0.7, main);
  a.addColorStop(1, main);
  ctx.fillStyle = a;
  ctx.fill(path);
  const e = ctx.createRadialGradient(-0.4, -0.5, 0, -0.4, -0.5, 2.35);
  e.addColorStop(0.62, edge + "00");
  e.addColorStop(1, edge + "bf");
  ctx.fillStyle = e;
  ctx.fill(path);
}

const HAPPY = "M-1.1 .45Q0 -1.25 1.1 .45";
const CLOSED = "M-1.15 0Q0 .75 1.15 0";

function drawEye(ctx: CanvasRenderingContext2D, e: EyePose, color: string, alpha: number) {
  const d2r = Math.PI / 180;
  ctx.save();
  ctx.translate(e.cx, e.cy);
  ctx.rotate(e.th * d2r);
  ctx.scale(e.fz, 1);
  ctx.rotate((-e.th + e.roll) * d2r);
  ctx.scale(e.rr, e.rr);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const w = (x: number) => Math.max(0, Math.min(1, x));
  if (w(e.glyphs.oval) > 0.005) {
    ctx.save();
    ctx.globalAlpha = alpha * w(e.glyphs.oval);
    ctx.scale(1 + (1 - e.blink) * 0.18, Math.max(e.open, 0.03));
    ctx.beginPath();
    ctx.ellipse(0, 0, 1, 1.76, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  for (const [glyph, d, width] of [
    ["happy", HAPPY, 0.95],
    ["closed", CLOSED, 0.8],
  ] as const) {
    const k = w(e.glyphs[glyph]);
    if (k <= 0.005 || !hasPath2D()) continue;
    ctx.save();
    ctx.globalAlpha = alpha * k;
    ctx.scale(0.9 + 0.1 * k, 0.9 + 0.1 * k);
    ctx.lineWidth = width;
    ctx.stroke(new Path2D(d));
    ctx.restore();
  }
  ctx.restore();
}

export interface DrawTarget {
  ctx: CanvasRenderingContext2D;
  /** Canvas size in device pixels (square). */
  px: number;
  /** Half the box in outline units. */
  half: number;
  /** Display size in CSS pixels (the slot). */
  size: number;
  /** Draw the flowing body live this frame (otherwise a frozen frame). */
  live: boolean;
}

/** Paints one frame. Returns true when the body came from WebGL. */
export function drawPose(t: DrawTarget, look: AvatarLook, pose: Pose): boolean {
  const { ctx, px, half } = t;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, px, px);
  const unit = px / (2 * half);
  let gl = false;

  if (!pose.bodyHidden) {
    ctx.globalAlpha = 1 - ERROR_FADE * pose.dim;
    if (t.live) {
      gl = drawBody(ctx, px, 0, 0, {
        look,
        size: t.size,
        half,
        tx: pose.tx,
        ty: pose.ty,
        rot: pose.rot,
        sx: pose.sx,
        sy: pose.sy,
        clock: pose.clock,
        energy: pose.energy,
        listen: pose.listen,
      });
    } else {
      const still = frozenBody(look, t.size, px, half);
      if (still) {
        ctx.setTransform(pose.sx, 0, 0, pose.sy, (px / 2) * (1 - pose.sx), (px / 2) * (1 - pose.sy));
        ctx.drawImage(still, 0, 0);
        gl = true;
      }
    }
    ctx.setTransform(unit, 0, 0, unit, px / 2, px / 2);
    ctx.translate(pose.tx, pose.ty);
    ctx.rotate((pose.rot * Math.PI) / 180);
    ctx.scale(pose.sx, pose.sy);
    if (!gl) flatBody(ctx, look);
    ctx.globalAlpha = 1;
    // Eyes sit inside the outline and never fade with the body.
    if (pose.eyesOpacity > 0.005) {
      ctx.save();
      const clip = shapePath(look.shape);
      if (clip) ctx.clip(clip);
      for (const e of pose.eyes) drawEye(ctx, e, look.eyeColor, pose.eyesOpacity);
      ctx.restore();
    }
  }

  ctx.setTransform(unit, 0, 0, unit, px / 2, px / 2);
  if (pose.bars > 0.005) {
    ctx.globalAlpha = pose.bars;
    ctx.fillStyle = look.main;
    [-0.5, -0.11, 0.28].forEach((x, i) => {
      const h = pose.barHeights[i]!;
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(x, -h / 2, 0.22, h, 0.11);
      else ctx.rect(x, -h / 2, 0.22, h);
      ctx.fill();
    });
  }
  if (pose.zz > 0.01 && t.size >= 48) {
    // Text in device pixels: browsers render sub-pixel font sizes poorly under a transform.
    ctx.setTransform(1, 0, 0, 1, px / 2, px / 2);
    ctx.fillStyle = look.palette[0];
    [0.34, 0.26].forEach((fs, i) => {
      const ph = (pose.zzPhase + i * 0.5) % 1;
      ctx.globalAlpha = pose.zz * Math.sin(ph * Math.PI);
      ctx.font = `600 ${(fs * unit).toFixed(2)}px system-ui, sans-serif`;
      ctx.fillText("z", (0.55 + ph * 0.25 + i * 0.05) * unit, (-0.5 - ph * 0.45) * unit);
    });
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return gl;
}
