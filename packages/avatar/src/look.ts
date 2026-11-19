// The shared look. Every avatar uses these values; only the palette, flow,
// seed and eyes come from the agent id. Each key is a shader uniform ("u" + key).

export const LOOK = {
  // Shape: 0 is a circle. The shader also has 12 other outlines, unused by avatars.
  Shape: 0,
  ShapeRot: 0,
  Wobble: 0,
  // Eyes (switched on per avatar)
  Eyes: 0,
  EyeType: 0,
  EyeCol: 0,
  EyeSize: 1.1,
  EyeGap: 0.46,
  EyeY: 0.06,
  EyeGlow: 0,
  // Colour grading
  Sat: 0.75,
  Bright: 0.99,
  Contrast: 1.94,
  Warm: 1.5,
  Hue: 0,
  Edge: 0,
  EdgeTurn: 1.55,
  EdgeWidth: 2,
  // Flow (FlowAng is set per avatar)
  FlowAng: 0.68,
  Stream: 0.95,
  EddyN: 2,
  EddyStr: 0.88,
  EddySize: 1.07,
  Scale: 1.2,
  Warp: 0,
  Detail: 0.35,
  Sharp: 0.69,
  L4: 1.5,
  L5: 1.5,
  Hi: 1.36,
  // Fine lines (off)
  Lines: 0,
  LineStyle: 3,
  LineDen: 27.6,
  LineW: 1.38,
  LineGrp: 0.23,
  LineGrpF: 1.67,
  LineWob: 0,
  LineCol: 0,
  LineDash: 8.8,
  LineFade: 1,
  // Brush texture
  Tex: 3,
  TexAmt: 0.2,
  TexScale: 0.66,
  BrushGap: 0.57,
  BrushLen: 1.06,
  BrushRough: 0.98,
  Impasto: 2.38,
  Poster: 0,
  Ridge: 0,
  Bleed: 0.41,
  Grain: 0.09,
  GrainSize: 1.3,
  // Lighting
  Lens: 2,
  Volume: 0.57,
  LightAng: 1.26,
  Diff: 0.59,
  Spec: 1.1,
  SpecSize: 34,
  Rim: 1.64,
  EdgeSoft: 0,
  // Size of the orb relative to its box, glow, and the voice response
  Size: 0.88,
  Glow: 0,
  SpeakWarp: 0,
  ListenRing: 1.34,
};

export type LookKey = keyof typeof LOOK;

/** Animation constants, applied in JavaScript rather than in the shader. */
export const MOTION = {
  /** Flow clock speed. */
  speed: 2.65,
  /** Extra flow speed at full speaking energy. */
  speakBoost: 0.55,
  /** Size pulse at full speaking volume. */
  pulse: 0.103,
  /** Idle breathing amplitude. */
  breath: 0.025,
};

/** Shader eye type per rule eye type. */
export const EYE_TYPE_UNIFORM = { bar: 0, dot: 1, oval: 2 } as const;
