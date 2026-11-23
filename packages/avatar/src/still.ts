// One still frame of an avatar: the same pose a canvas avatar rests in,
// drawn with the shared WebGL body. Used on the page and in the image worker.
import { ENLARGED_HALF, SLOT_HALF, drawPose } from "./draw.js";
import { Face, type AvatarExpression, type AvatarState, type EyePose } from "./face.js";
import { avatarLook } from "./rule.js";
import type { Ctx2D } from "./surface.js";

export interface StillJob {
  seed: string;
  /** Slot size in CSS pixels. */
  size: number;
  /** Canvas size in device pixels. */
  px: number;
  state?: AvatarState;
  expression?: AvatarExpression;
  variant?: "slot" | "enlarged";
  /** Eyes shut, as at the deepest point of a blink. */
  blink?: boolean;
}

/** The deepest point of a blink, as the canvas draws it: squashed to 6%, a little wider and lower. */
const BLINK_OPEN = 0.06;
function closeEye(e: EyePose): EyePose {
  return { ...e, blink: BLINK_OPEN, open: e.open * BLINK_OPEN, cy: e.cy + (1 - BLINK_OPEN) * e.rr * 0.5 };
}

export function stillPose(seed: string, job: Pick<StillJob, "size" | "state" | "expression">) {
  return new Face(avatarLook(seed), {
    size: job.size,
    state: job.state ?? "idle",
    expression: job.expression,
    animated: false,
    reducedMotion: true,
    interactive: false,
  }).step(0);
}

/** Draws the still frame into `ctx` (px × px). Returns false without WebGL. */
export function stillFrame(ctx: Ctx2D, job: StillJob): boolean {
  const look = avatarLook(job.seed);
  const pose = stillPose(job.seed, job);
  if (job.blink) pose.eyes = pose.eyes.map((e) => closeEye(e)) as typeof pose.eyes;
  const half = job.variant === "enlarged" ? ENLARGED_HALF : SLOT_HALF;
  return drawPose({ ctx, px: job.px, half, size: job.size, live: false }, look, pose);
}
