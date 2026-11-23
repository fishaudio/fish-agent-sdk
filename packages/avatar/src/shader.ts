// The body shader: a painted, flowing orb clipped to the avatar's outline.
// Colour patches drift one way under fine, slow brush strokes. Eyes, bars
// and other marks are drawn on top in 2D, so they stay crisp at any size.

export const VERTEX_SHADER = `attribute vec2 p; varying vec2 uv; void main(){ uv = p; gl_Position = vec4(p, 0., 1.); }`;

/** Uniforms set from {@link bodyUniforms}. */
export const BODY_UNIFORMS = [
  "uSize",
  "uShapeRot",
  "uFlowAng",
  "uStream",
  "uScale",
  "uDetail",
  "uSharp",
  "uL4",
  "uL5",
  "uHi",
  "uBleed",
  "uTexAmt",
  "uTexScale",
  "uBrushGap",
  "uBrushLen",
  "uBrushRough",
  "uImpasto",
  "uGrain",
  "uGrainSize",
  "uLens",
  "uVolume",
  "uLightAng",
  "uDiff",
  "uSpec",
  "uSpecSize",
  "uRim",
  "uContrast",
  "uWarm",
  "uSat",
  "uBright",
  "uListenRing",
] as const;

export type BodyUniform = (typeof BODY_UNIFORMS)[number];

export const FRAGMENT_SHADER = `#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 uv;
uniform float t, energy, listen, uResY;
uniform vec3 c0, c1, c2, c3, c4, c5;
uniform float uRT[64];
uniform vec2 uOff, uSclD;
uniform float ${BODY_UNIFORMS.join(", ")};
float rtab(float a){ float u = fract(a / 6.28318) * 64.; float i1 = floor(u), f = u - i1, i0 = mod(i1 + 63., 64.), i2 = mod(i1 + 1., 64.), i3 = mod(i1 + 2., 64.);
  float p0 = 1., p1 = 1., p2 = 1., p3 = 1.;
  for (int i = 0; i < 64; i++) { float fi = float(i); if (fi == i0) p0 = uRT[i]; if (fi == i1) p1 = uRT[i]; if (fi == i2) p2 = uRT[i]; if (fi == i3) p3 = uRT[i]; }
  return p1 + .5*f*(p2 - p0 + f*(2.*p0 - 5.*p1 + 4.*p2 - p3 + f*(3.*(p1 - p2) + p3 - p0))); }
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
float fbm2(vec2 p){ return .65*n(p) + .35*n(p*2.03 + 17.); }
float fbm(vec2 p){ float v = 0., a = .5; mat2 r = mat2(.8,.6,-.6,.8); for (int k = 0; k < 4; k++){ v += a*n(p); p = r*p*2.02; a *= .5; } return v / .94; }
float field(vec2 p){ return mix(fbm2(p), fbm(p), uDetail); }
float band(float x, float c, float w){ w *= uSharp; return smoothstep(c - w, c + w, x); }
void main(){
  vec2 q0 = (uv - uOff) / (uSize * (1. + uSclD));
  float cr = cos(uShapeRot), sr = sin(uShapeRot);
  vec2 qs = mat2(cr, sr, -sr, cr) * q0;
  float r = length(qs) / rtab(atan(qs.y, qs.x));
  vec2 gr = vec2(dFdx(r), dFdy(r));
  vec2 rv = normalize(mix(gr / max(length(gr), 1e-6), q0 / max(length(q0), 1e-6), .4) + 1e-6) * r;
  float aaR = max(fwidth(r) * 1.6, .014);
  vec2 fc = gl_FragCoord.xy * (920. / uResY);
  if (r > 1.) { gl_FragColor = vec4(0.); return; }
  float z = sqrt(max(0., 1. - r*r));
  float zl = sqrt(1. - r*r*.82);
  vec2 s = q0 / mix(1., .85 + .25*zl, uLens);
  float sp = t;
  vec2 dirF = vec2(cos(uFlowAng), sin(uFlowAng));
  vec2 nrmF = vec2(-dirF.y, dirF.x);
  vec2 pp = s - dirF * sp * .24 * uStream;
  vec2 q = pp * uScale;
  float f = field(q*.85);
  float g = field(q*.75 + vec2(7.1, 3.3));
  float m = field(q*.65 + vec2(13.7, 9.1));
  vec3 col = mix(c1, c2, band(f, .5, .18));
  col = mix(col, c4, band(g, .56, .14) * .9 * min(uL4, 1.));
  col = mix(col, c5, band(m, .57, .13) * .95 * min(uL5, 1.));
  col = mix(col, c3, band(f*.6 + g*.5, .73, .13) * .55 * uHi);
  if (uL4 > 1.) col = mix(col, c4, (uL4 - 1.) * band(g, .4, .2));
  if (uL5 > 1.) col = mix(col, c5, (uL5 - 1.) * band(m, .4, .2));
  float H = f*.6 + g*.4;
  if (uBleed > 0.) {
    float gb = length(vec2(dFdx(f), dFdy(f))) * uResY * .12;
    col = mix(col, col * mix(vec3(1.), c0 / max(max(c0.r, c0.g), max(c0.b, .01)), .5) * .82, clamp(gb, 0., 1.) * uBleed * .6);
  }
  // fine brush strokes along the flow
  float yS = dot(pp, nrmF) + .18*(f - .5);
  float xS = dot(pp, dirF);
  vec2 bp = vec2(xS*5./uBrushLen, yS*45./uBrushGap) / uTexScale;
  float tex = (n(bp) - .5)*1.3 + (n(bp*vec2(.5, 2.3)) - .5)*.5 + (n(bp*vec2(6., 1.7)) - .5)*uBrushRough*1.2;
  col *= 1. + tex * uTexAmt * .14;
  vec2 tg = vec2(dFdx(tex), dFdy(tex)) * uTexAmt * .5;
  // light and volume
  vec3 nrm = normalize(mix(vec3(0., 0., 1.), vec3(rv, z + .001), clamp(uVolume, 0., 1.)) + vec3(rv, 0.)*max(uVolume - 1., 0.));
  if (uImpasto > 0.) { vec2 gi = clamp(vec2(dFdx(H), dFdy(H)) * uResY * .02 * uImpasto, -1.5, 1.5); nrm = normalize(nrm + vec3(-gi - tg, 0.)); }
  else nrm = normalize(nrm + vec3(-tg, 0.));
  vec3 L = normalize(vec3(cos(uLightAng)*.71, sin(uLightAng)*.71, .72));
  float diff = clamp(dot(nrm, L), 0., 1.);
  col *= mix(1., .72 + .42*diff, uDiff);
  float spec = pow(max(dot(nrm, normalize(L + vec3(0., 0., 1.))), 0.), uSpecSize);
  col = mix(col, c3, clamp(spec * .35 * uSpec, 0., 1.));
  col = mix(col, c3, clamp(smoothstep(.86, 1., r) * smoothstep(.0, .6, dot(normalize(rv + .0001), L.xy)) * .14 * uRim, 0., 1.));
  col = clamp(col, 0., 1.); col = mix(col, col*col*(3. - 2.*col), .28*uContrast);
  float L0 = dot(col, vec3(.299, .587, .114));
  col = mix(vec3(L0) * mix(vec3(1.), vec3(1.03, 1., .95), uWarm), col, uSat);
  col *= uBright;
  col += (h(floor(fc / uGrainSize)) - .5) * uGrain;
  col = mix(col, c3, smoothstep(.8, 1., r) * listen * (.08 + .05*sin(t*2.2)) * uListenRing);
  float alpha = 1. - smoothstep(1. - aaR, 1. + aaR*.2, r);
  gl_FragColor = vec4(clamp(col, 0., 1.) * alpha, alpha);
}`;

/** The reference orb's tuning, with the slow one-way drift (no eddies). */
const BASE = {
  Stream: 0.95 * 0.8,
  Scale: 1.2,
  Detail: 0.35,
  Sharp: 0.69,
  L4: 1.5,
  L5: 1.5,
  Hi: 1.36,
  Bleed: 0.41,
  TexAmt: 0.2,
  TexScale: 0.66,
  BrushGap: 0.57,
  BrushLen: 1.06,
  BrushRough: 0.98,
  Impasto: 2.38,
  Grain: 0.09,
  GrainSize: 1.3,
  Lens: 2,
  Volume: 0.57,
  LightAng: 1.26,
  Diff: 0.59,
  Spec: 1.1,
  SpecSize: 34,
  Rim: 1.64,
  Contrast: 1.94,
  Warm: 1.5,
  Sat: 1.3,
  Bright: 0.99,
  ListenRing: 1.34,
};

/** Softening of the fine brush texture: larger strokes, quieter grain. */
export const SOFTEN = 0.65;

/**
 * Texture strength at a display size: full from 96 px; at 20 px about 15%
 * grain, 30% brush, 20% impasto.
 */
export function textureScale(size: number): number {
  return Math.max(0, Math.min(1, (size - 20) / (96 - 20)));
}

/** Uniform values for the body at a display size. `uSize` and `uShapeRot` are set per frame. */
export function bodyUniforms(size: number): Record<BodyUniform, number> {
  const so = SOFTEN;
  const k = textureScale(size);
  const L = (lo: number) => lo + (1 - lo) * k;
  const texAmt = BASE.TexAmt * (1 - 0.15 * so);
  return {
    uSize: 1,
    uShapeRot: 0,
    uFlowAng: 0,
    uStream: BASE.Stream,
    uScale: BASE.Scale,
    uDetail: BASE.Detail * (1 - 0.5 * so) * L(0.4),
    uSharp: BASE.Sharp,
    uL4: BASE.L4,
    uL5: BASE.L5,
    uHi: BASE.Hi,
    uBleed: BASE.Bleed * L(0.4),
    uTexAmt: texAmt * L(0.3),
    uTexScale: BASE.TexScale * (1 + 0.9 * so),
    uBrushGap: BASE.BrushGap,
    uBrushLen: BASE.BrushLen,
    uBrushRough: BASE.BrushRough * (1 - 0.75 * so) * L(0.35),
    uImpasto: BASE.Impasto * (1 - 0.45 * so) * L(0.2),
    uGrain: BASE.Grain * (1 - 0.65 * so) * L(0.15),
    uGrainSize: BASE.GrainSize * (1 + 0.8 * so),
    uLens: BASE.Lens,
    uVolume: BASE.Volume,
    uLightAng: BASE.LightAng,
    uDiff: BASE.Diff,
    uSpec: BASE.Spec,
    uSpecSize: BASE.SpecSize,
    uRim: BASE.Rim,
    uContrast: BASE.Contrast,
    uWarm: BASE.Warm,
    uSat: BASE.Sat,
    uBright: BASE.Bright,
    uListenRing: BASE.ListenRing,
  };
}
