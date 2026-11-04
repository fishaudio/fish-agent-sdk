// The 18 body outlines. Every outline is full and rounded: a convex hull of
// circles, or a polar curve whose notches stay within a third of the radius.
// Outlines are scaled to the same area as a circle of radius 0.92, and never
// reach past 1.04 from the centre, so wide shapes do not look bigger.
// Coordinates are SVG-style: x to the right, y down.

const D2R = Math.PI / 180;

type Circle = readonly [x: number, y: number, r: number];
/** Eye anchor: x and y offsets plus a size factor, tuned per outline. */
export type EyeAnchor = readonly [x: number, y: number, scale: number];

interface ShapeDef {
  circles?: ReadonlyArray<Circle>;
  polar?: (angle: number) => number;
  eye: EyeAnchor;
}

const rot = (pts: ReadonlyArray<Circle>, deg: number): Circle[] =>
  pts.map(([x, y, r]) => {
    const c = Math.cos(deg * D2R);
    const s = Math.sin(deg * D2R);
    return [x * c - y * s, x * s + y * c, r] as const;
  });

const ngon = (n: number, rounding: number, deg = 0): Circle[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (deg - 90 + (i * 360) / n) * D2R;
    return [Math.cos(a) * (1 - rounding), Math.sin(a) * (1 - rounding), rounding] as const;
  });

/** Outline names, in rule order. The index is what {@link avatarLook} returns as `shape`. */
export const AVATAR_SHAPES = [
  "circle",
  "squircle",
  "capsule",
  "pebble",
  "egg",
  "mochi",
  "softtri",
  "tallcap",
  "loaf",
  "softpent",
  "dome",
  "wideegg",
  "softhex",
  "softdiamond",
  "softstar",
  "cookie",
  "clover",
  "blossom",
] as const;

export type AvatarShapeName = (typeof AVATAR_SHAPES)[number];

const DEFS: Record<AvatarShapeName, ShapeDef> = {
  circle: { circles: [[0, 0, 1]], eye: [0.12, -0.16, 1] },
  squircle: { circles: rot(ngon(4, 0.58, 45), 6), eye: [0.12, -0.14, 1] },
  capsule: { circles: rot([[-0.32, 0, 0.72], [0.32, 0, 0.72]], -8), eye: [0.14, -0.12, 1] },
  pebble: { circles: rot([[0, 0, 0.74], [0, 0.4, 0.54]], -110), eye: [0.16, -0.1, 1] },
  egg: { circles: [[0, 0.14, 0.84], [0, -0.22, 0.66]], eye: [0.12, -0.14, 1] },
  mochi: { circles: [[-0.42, 0.22, 0.62], [0.42, 0.22, 0.62], [0, -0.18, 0.78]], eye: [0.12, -0.06, 1] },
  softtri: { circles: rot(ngon(3, 0.62), -6), eye: [0.06, -0.04, 0.95] },
  tallcap: { circles: rot([[0, -0.26, 0.74], [0, 0.26, 0.74]], 8), eye: [0.12, -0.22, 0.95] },
  loaf: {
    circles: [[-0.36, -0.2, 0.56], [0.36, -0.2, 0.56], [-0.36, 0.22, 0.56], [0.36, 0.22, 0.56]],
    eye: [0.12, -0.14, 1],
  },
  softpent: { circles: rot(ngon(5, 0.52), -8), eye: [0.1, -0.1, 0.98] },
  dome: { circles: [[-0.5, 0.26, 0.5], [0.5, 0.26, 0.5], [0, -0.08, 0.86]], eye: [0.12, -0.12, 1] },
  wideegg: { circles: rot([[0, 0.14, 0.84], [0, -0.22, 0.66]], 78), eye: [0.14, -0.12, 1] },
  softhex: { circles: rot(ngon(6, 0.46), 8), eye: [0.12, -0.12, 1] },
  softdiamond: { circles: rot(ngon(4, 0.56), -8), eye: [0.1, -0.06, 0.95] },
  softstar: {
    polar: (a) => 0.68 + 0.32 * Math.pow(0.5 + 0.5 * Math.cos(5 * (a + Math.PI / 2)), 1.5),
    eye: [0.12, -0.02, 0.9],
  },
  cookie: { polar: (a) => 0.86 + 0.14 * (0.5 + 0.5 * Math.cos(8 * a + 0.3)), eye: [0.12, -0.12, 1] },
  clover: {
    polar: (a) => 0.74 + 0.26 * Math.pow(0.5 + 0.5 * Math.cos(4 * (a + Math.PI / 4)), 0.7),
    eye: [0.12, -0.1, 0.95],
  },
  blossom: {
    polar: (a) => 0.76 + 0.24 * Math.pow(0.5 + 0.5 * Math.cos(6 * (a + Math.PI / 2)), 1.1),
    eye: [0.12, -0.08, 0.95],
  },
};

export interface AvatarShape {
  name: AvatarShapeName;
  /** Outline points, centred, equal area. */
  points: ReadonlyArray<readonly [number, number]>;
  /** SVG path data for the outline, in the same units. */
  path: string;
  /** Distance to the outline at 64 evenly spaced angles, for the shader (y up). */
  radii: Float32Array;
  eye: EyeAnchor;
}

const SAMPLES = 180;

function outline(def: ShapeDef): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < SAMPLES; k++) {
    const a = (k / SAMPLES) * 2 * Math.PI;
    if (def.polar) {
      const r = def.polar(a);
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
      continue;
    }
    const ux = Math.cos(a);
    const uy = Math.sin(a);
    let best = -Infinity;
    let p: [number, number] = [0, 0];
    for (const [x, y, r] of def.circles!) {
      const h = x * ux + y * uy + r;
      if (h > best) {
        best = h;
        p = [x + r * ux, y + r * uy];
      }
    }
    pts.push(p);
  }
  return pts;
}

/** Polygon area (shoelace). */
export function polygonArea(pts: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[(i + 1) % pts.length]!;
    a += ax * by - bx * ay;
  }
  return Math.abs(a) / 2;
}

function build(name: AvatarShapeName): AvatarShape {
  const def = DEFS[name];
  const raw = outline(def);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of raw) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  // Same area as a circle of radius 0.92, but never wider than 1.04 from the centre.
  let s = 0.92 * Math.sqrt(Math.PI / polygonArea(raw));
  const extent = Math.max(x1 - x0, y1 - y0) / 2;
  if (extent * s > 1.04) s = 1.04 / extent;
  const points = raw.map(([x, y]) => [(x - cx) * s, (y - cy) * s] as const);
  const path =
    "M" + points.map(([x, y]) => `${x.toFixed(3)} ${y.toFixed(3)}`).join("L") + "Z";
  // Ray casts from the centre, for the shader's lookup table (y flipped to point up).
  const radii = new Float32Array(64);
  for (let i = 0; i < 64; i++) {
    const th = (i / 64) * 2 * Math.PI;
    const dx = Math.cos(th);
    const dy = -Math.sin(th);
    let best = 0;
    for (let j = 0; j < points.length; j++) {
      const [px, py] = points[j]!;
      const [qx, qy] = points[(j + 1) % points.length]!;
      const ex = qx - px;
      const ey = qy - py;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (px * ey - py * ex) / den;
      const u = (px * dy - py * dx) / den;
      if (u >= -1e-6 && u <= 1 + 1e-6 && t > best) best = t;
    }
    radii[i] = best;
  }
  return { name, points, path, radii, eye: def.eye };
}

const built = new Map<AvatarShapeName, AvatarShape>();

/** The outline at `index` (0–17) in {@link AVATAR_SHAPES}. Built once, then cached. */
export function avatarShape(index: number): AvatarShape {
  const name = AVATAR_SHAPES[((index % AVATAR_SHAPES.length) + AVATAR_SHAPES.length) % AVATAR_SHAPES.length]!;
  let shape = built.get(name);
  if (!shape) {
    shape = build(name);
    built.set(name, shape);
  }
  return shape;
}
