// The avatar rule: any agent id maps to one stable look. It is a pure function
// with no DOM or WebGL, so servers, tests and other renderers get the same
// result. Changing anything here changes every agent's face, so it is a
// breaking change.

/** Hue bands as [from, to, weight] in degrees. Yellow-green (48–95°) is skipped. */
const HUE_BANDS: ReadonlyArray<readonly [number, number, number]> = [
  [160, 195, 9],
  [195, 235, 10],
  [235, 285, 10],
  [285, 345, 10],
  [345, 380, 8],
  [20, 44, 5],
  [100, 160, 8],
];
const HUE_TOTAL = HUE_BANDS.reduce((sum, band) => sum + band[2], 0);

/**
 * Three lightness tiers, each with six [saturation, lightness] pairs in palette
 * order: edge, main, light, highlight, second, neighbour.
 */
const TIERS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[0.62, 0.5], [0.66, 0.64], [0.62, 0.8], [0.6, 0.96], [0.54, 0.8], [0.52, 0.68]],
  [[0.58, 0.44], [0.62, 0.58], [0.6, 0.76], [0.6, 0.95], [0.52, 0.74], [0.5, 0.62]],
  [[0.56, 0.56], [0.6, 0.7], [0.58, 0.84], [0.6, 0.97], [0.5, 0.84], [0.48, 0.74]],
];
/** Hue offset of each palette colour from the main hue, in degrees. */
const HUE_OFFSETS = [-4, 0, -6, 0, 24, -20];
/** Bars are twice as likely as dots or ovals. */
const EYE_TYPES: ReadonlyArray<AvatarEyeType> = ["bar", "bar", "dot", "oval"];

/** Avatars this size and up (CSS pixels) get eyes. */
export const EYES_MIN_SIZE = 64;

export type AvatarEyeType = "bar" | "dot" | "oval";

export interface AvatarEyes {
  type: AvatarEyeType;
  /** Gaze, left to right, -0.6 to 0.6. */
  lookX: number;
  /** Gaze, down to up, -0.25 to 0.25. */
  lookY: number;
  /** About one in four smiles. */
  smile: boolean;
}

/** Six hex colours: edge, main, light, highlight, second, neighbour. */
export type AvatarPalette = readonly [string, string, string, string, string, string];

export interface AgentAvatarLook {
  id: string;
  /** The id's index, 0 to 99999. Everything below derives from it. */
  n: number;
  /** Main hue in degrees. */
  hue: number;
  /** Lightness tier: 0, 1 or 2. Neighbouring indices alternate. */
  tier: number;
  palette: AvatarPalette;
  /** Animation seed: where the flow starts. */
  seed: number;
  /** Flow direction in radians. */
  flowAngle: number;
  /** Eyes, or null below {@link EYES_MIN_SIZE}. */
  eyes: AvatarEyes | null;
}

const frac = (x: number) => x - Math.floor(x);

function hsl(h: number, s: number, l: number): string {
  const hue = (((h % 360) + 360) % 360) / 360;
  const channel = (n: number) => {
    const k = (n + hue * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (
    "#" +
    [channel(0), channel(8), channel(4)]
      .map((v) => Math.round(v * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

function hueAt(u: number): number {
  let x = u * HUE_TOTAL;
  for (const [from, to, weight] of HUE_BANDS) {
    if (x < weight) return (from + ((to - from) * x) / weight) % 360;
    x -= weight;
  }
  return HUE_BANDS[0]![0];
}

/** FNV-1a over the id's code points, reduced to 0–99999. */
export function avatarIndex(id: string): number {
  let x = 2166136261;
  for (const ch of String(id)) {
    x ^= ch.codePointAt(0)!;
    x = Math.imul(x, 16777619);
  }
  return (x >>> 0) % 100000;
}

/**
 * The look for an agent id at a display size (CSS pixels). The same id always
 * gives the same colours, flow and eyes. Size only decides whether there are
 * eyes.
 */
export function agentAvatar(id: string, size = 40): AgentAvatarLook {
  const n = avatarIndex(id);
  // Golden-ratio steps along the weighted bands spread any number of avatars evenly.
  const hue = hueAt(frac(n * 0.6180339887 + 0.5));
  const tier = n % 3;
  const palette = TIERS[tier]!.map(([s, l], i) =>
    hsl(hue + HUE_OFFSETS[i]!, s, l),
  ) as unknown as AvatarPalette;
  const seed = frac(n * 0.7548776662) * 97 + 3;
  const flowAngle = frac(n * 0.569840291) * 6.2832 - 3.1416;
  // Each expression trait multiplies n by its own constant, so traits vary independently.
  const h = (k: number) => ((n * k) % 1000) / 1000;
  const eyes: AvatarEyes | null =
    size < EYES_MIN_SIZE
      ? null
      : {
          type: EYE_TYPES[Math.floor(h(379) * 4)]!,
          lookX: (h(613) - 0.5) * 1.2,
          lookY: (h(911) - 0.5) * 0.5,
          smile: h(127) < 0.25,
        };
  return { id: String(id), n, hue, tier, palette, seed, flowAngle, eyes };
}
