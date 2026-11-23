// The avatar rule: any seed (an agent id, or a template key) maps to one
// stable look. It is a pure function with no DOM or WebGL, so servers, tests
// and other renderers get the same result. Changing anything here changes
// every agent's face, so it is a breaking change.

import { AVATAR_SHAPES, avatarShape, type AvatarShapeName, type EyeAnchor } from "./shapes.js";

/** The 13 body colours, in rule order. The index is what {@link avatarLook} returns as `color`. */
export const AVATAR_COLORS = [
  "#5B7FD6",
  "#D9773B",
  "#4E9A78",
  "#8D77C9",
  "#2B2926",
  "#C9677E",
  "#4A979D",
  "#C9993D",
  "#8A8680",
  "#6E8FB0",
  "#B8796A",
  "#7E9C5E",
  "#A47FB0",
] as const;

/** Main colours brighter than this get dark eyes instead of white. */
export const DARK_EYES_ABOVE = 0.82;

/**
 * @deprecated Eyes are drawn at every size now. Kept for compatibility; always 0.
 */
export const EYES_MIN_SIZE = 0;

/** @deprecated Every avatar has oval eyes now. */
export type AvatarEyeType = "bar" | "dot" | "oval";

export interface AvatarEyes {
  /** Always `"oval"`: a vertical ellipse, 1 : 1.76. */
  type: AvatarEyeType;
  /** Resting gaze, left to right. */
  lookX: number;
  /** Resting gaze, up (negative) to down (positive). Slightly down: the agent is listening. */
  lookY: number;
  /** Resting eyes do not smile. */
  smile: boolean;
  /** Eye size factor at the requested display size: ×1.45 to 24 px, ×1.25 to 48 px, ×1.15 above. */
  scale: number;
  /** Eye colour: white, or near-black on very light bodies. */
  color: string;
  /** Where the eyes sit on this outline. */
  anchor: EyeAnchor;
}

/** Six hex colours: edge, main, light, highlight, second, neighbour. */
export type AvatarPalette = readonly [string, string, string, string, string, string];

export interface AvatarLook {
  /** The seed, as given. */
  id: string;
  /** The seed's index, 0 to 99999. Everything below derives from it. */
  n: number;
  /** Outline index, 0–17, into {@link AVATAR_SHAPES}. */
  shape: number;
  shapeName: AvatarShapeName;
  /** Colour index, 0–12, into {@link AVATAR_COLORS}. */
  color: number;
  /** The main colour, from {@link AVATAR_COLORS}. */
  main: string;
  /** Main hue in degrees. */
  hue: number;
  /** The main colour spread to six: the second and neighbour colours turn ±20° so colour patches move in the flow. */
  palette: AvatarPalette;
  /** Eye colour: white, or near-black when the main colour's luminance is above {@link DARK_EYES_ABOVE}. */
  eyeColor: string;
  /** Animation seed: where the flow starts, in shader time. */
  seed: number;
  /** Flow direction in radians. The flow drifts one way, slowly. */
  flowAngle: number;
}

export interface AgentAvatarLook extends AvatarLook {
  eyes: AvatarEyes;
}

/** FNV-1a over the seed's code points, reduced to 0–99999. */
export function avatarIndex(id: string): number {
  let x = 2166136261;
  for (const ch of String(id)) {
    x ^= ch.codePointAt(0)!;
    x = Math.imul(x, 16777619);
  }
  return (x >>> 0) % 100000;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (v: number[]) =>
  "#" + v.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

/** Mixes `hex` toward `target` by `k` (0–1). */
export function mixHex(hex: string, target: string, k: number): string {
  const a = rgb(hex);
  const b = rgb(target);
  return toHex(a.map((v, i) => v + (b[i]! - v) * k));
}

/** Relative luminance, 0–1 (Rec. 601 weights). */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex) as [number, number, number];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function hsl(h: number, s: number, l: number): string {
  const hue = (((h % 360) + 360) % 360) / 360;
  const channel = (n: number) => {
    const k = (n + hue * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return toHex([channel(0), channel(8), channel(4)].map((v) => v * 255));
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

function hueRotate(hex: string, deg: number): string {
  const [h, s, l] = toHsl(hex);
  if (!s) return hex;
  return hsl(h + deg, s, l);
}

/** The six-colour palette for a main colour. */
export function expandPalette(main: string): AvatarPalette {
  return [
    mixHex(main, "#000000", 0.18),
    main.toLowerCase(),
    mixHex(main, "#ffffff", 0.4),
    mixHex(main, "#ffffff", 0.9),
    mixHex(hueRotate(main, 22), "#ffffff", 0.22),
    mixHex(hueRotate(main, -20), "#ffffff", 0.08),
  ];
}

/**
 * The look for a seed. Pure and SSR-safe: the same seed always gives the same
 * outline (one of 18), colour (one of 13), flow and eye placement. Pass an
 * agent id, or a stable template key so every agent made from that template
 * shares its face.
 */
export function avatarLook(seed: string): AvatarLook {
  const id = String(seed);
  const n = avatarIndex(id);
  // 18 and 13 share no factor, so every outline meets every colour.
  const shape = n % AVATAR_SHAPES.length;
  const color = n % AVATAR_COLORS.length;
  const main = AVATAR_COLORS[color]!;
  return {
    id,
    n,
    shape,
    shapeName: AVATAR_SHAPES[shape]!,
    color,
    main,
    hue: toHsl(main)[0],
    palette: expandPalette(main),
    eyeColor: luminance(main) > DARK_EYES_ABOVE ? "#1A1A1A" : "#FFFFFF",
    seed: (n % 97) + 3,
    flowAngle: (n % 628) / 100 - 3.14,
  };
}

/** Eye size factor for a display size in CSS pixels. Small avatars get larger eyes so they stay visible. */
export function eyeScaleFor(size: number): number {
  return size <= 24 ? 1.45 : size <= 48 ? 1.25 : 1.15;
}

/**
 * The look for an agent id at a display size (CSS pixels), with resting eyes.
 * Same as {@link avatarLook} plus `eyes`; size only changes the eye scale.
 */
export function agentAvatar(id: string, size = 40): AgentAvatarLook {
  const look = avatarLook(id);
  const anchor = avatarShape(look.shape).eye;
  return {
    ...look,
    eyes: {
      type: "oval",
      lookX: 0,
      lookY: 0.06,
      smile: false,
      scale: anchor[2] * eyeScaleFor(size),
      color: look.eyeColor,
      anchor,
    },
  };
}
