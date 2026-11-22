// Still avatars as images. A canvas per avatar is costly to paint and
// composite in long lists, so still avatars are drawn once by the shared
// WebGL renderer into a PNG and shown with <img>. Every copy of the same
// seed, size, state and expression shares one image.
import { ENLARGED_CANVAS, ENLARGED_HALF, SLOT_HALF, drawPose } from "./draw.js";
import { Face, type AvatarExpression, type AvatarState, type EyePose } from "./face.js";
import { hasWebGL } from "./renderer.js";
import { avatarLook } from "./rule.js";

export interface AvatarImageOptions {
  /** Slot size in CSS pixels. Defaults to 40. */
  size?: number;
  state?: AvatarState;
  expression?: AvatarExpression;
  /** The blink frame: same avatar with the eyes shut. Only differs where the eyes are open ovals. */
  blink?: boolean;
  variant?: "slot" | "enlarged";
  /** Device pixel ratio to render at. Defaults to the screen's, capped at 2. */
  dpr?: number;
}

export interface AvatarImage {
  /** Cache key: seed, pixel size, state, expression and variant. */
  key: string;
  /** The image URL once rendered, else null. */
  url: string | null;
  /** Resolves with the URL, or null where WebGL is unavailable. */
  ready: Promise<string | null>;
  /** Width and height of the image in CSS pixels (1.25× the slot when enlarged). */
  cssSize: number;
  /** Gives the image back. Unused images are kept for a while, then freed. */
  release(): void;
}

interface Entry {
  url: string | null;
  ready: Promise<string | null>;
  refs: number;
}

/** Unused images kept around for reuse before their memory is freed. */
export const IDLE_IMAGE_LIMIT = 96;

const entries = new Map<string, Entry>();
/** Keys with no users, oldest first. */
const idle = new Set<string>();
let renders = 0;

function revoke(entry: Entry) {
  if (entry.url && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(entry.url);
  }
}

function trim(limit: number) {
  for (const key of idle) {
    if (idle.size <= limit) break;
    idle.delete(key);
    const entry = entries.get(key);
    if (entry && entry.refs === 0) {
      entries.delete(key);
      revoke(entry);
    }
  }
}

/** The deepest point of a blink, as the canvas draws it: squashed to 6%, a little wider and lower. */
const BLINK_OPEN = 0.06;
function closeEye(e: EyePose): EyePose {
  return { ...e, blink: BLINK_OPEN, open: e.open * BLINK_OPEN, cy: e.cy + (1 - BLINK_OPEN) * e.rr * 0.5 };
}

/** Whether a still pose has eyes that can blink (open ovals, not happy or sleepy, not connecting). */
export function canBlink(o: Pick<AvatarImageOptions, "size" | "state" | "expression">): boolean {
  const pose = new Face(avatarLook("x"), {
    size: o.size ?? 40,
    state: o.state ?? "idle",
    expression: o.expression,
    animated: false,
    reducedMotion: true,
    interactive: false,
  }).step(0);
  return !pose.bodyHidden && pose.eyesOpacity > 0.5 && pose.eyes.every((e) => e.glyphs.oval > 0.5);
}

function render(seed: string, size: number, px: number, o: AvatarImageOptions): Promise<string | null> {
  if (typeof document === "undefined" || !hasWebGL()) return Promise.resolve(null);
  const enlarged = o.variant === "enlarged";
  const half = enlarged ? ENLARGED_HALF : SLOT_HALF;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = px;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  const look = avatarLook(seed);
  // The same still frame a canvas avatar draws when it is not moving.
  const pose = new Face(look, {
    size,
    state: o.state ?? "idle",
    expression: o.expression,
    animated: false,
    reducedMotion: true,
    interactive: false,
  }).step(0);
  if (o.blink) pose.eyes = pose.eyes.map((e) => closeEye(e)) as typeof pose.eyes;
  if (!drawPose({ ctx, px, half, size, live: false }, look, pose)) return Promise.resolve(null);
  renders++;
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === "function" && typeof URL.createObjectURL === "function") {
      canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), "image/png");
    } else {
      resolve(canvas.toDataURL("image/png"));
    }
  });
}

/**
 * A still image of the avatar, rendered once and shared by every caller
 * with the same seed, size, state, expression and variant. Call `release()`
 * when it is no longer shown. Returns `url: null` (and `ready` resolves to
 * null) where WebGL is unavailable: use {@link avatarSvg} there.
 */
export function acquireAvatarImage(seed: string, options: AvatarImageOptions = {}): AvatarImage {
  const size = options.size ?? 40;
  const enlarged = options.variant === "enlarged";
  const cssSize = enlarged ? size * ENLARGED_CANVAS : size;
  const dpr = Math.min(2, options.dpr ?? ((typeof devicePixelRatio === "number" && devicePixelRatio) || 1));
  const px = Math.max(1, Math.round(cssSize * dpr));
  const key = [seed, size, px, options.state ?? "idle", options.expression ?? "", enlarged ? "e" : "s", options.blink ? "b" : ""].join("\u0000");
  let entry = entries.get(key);
  if (!entry) {
    const created: Entry = { url: null, ready: Promise.resolve(null), refs: 0 };
    created.ready = render(seed, size, px, options).then((url) => {
      if (entries.get(key) === created) created.url = url;
      else if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
      return url;
    });
    entries.set(key, created);
    entry = created;
  }
  entry.refs++;
  idle.delete(key);
  const held = entry;
  let released = false;
  return {
    key,
    get url() {
      return held.url;
    },
    ready: held.ready,
    cssSize,
    release() {
      if (released) return;
      released = true;
      held.refs--;
      if (held.refs === 0 && entries.get(key) === held) {
        idle.add(key);
        trim(IDLE_IMAGE_LIMIT);
      }
    },
  };
}

/** Frees every image that nobody is using. */
export function clearAvatarImages(): void {
  trim(0);
}

/** Cache counters, for tests and diagnostics. */
export function avatarImageStats(): { images: number; idle: number; renders: number } {
  return { images: entries.size, idle: idle.size, renders };
}
