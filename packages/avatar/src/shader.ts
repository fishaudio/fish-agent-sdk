// The orb shader. One full-screen quad; the fragment shader draws a fluid,
// painted sphere from six palette colours, with optional eyes. Every look
// parameter is a float uniform named "u" + key (see look.ts).
import { LOOK } from "./look.js";

const UNIFORMS = Object.keys(LOOK).map((key) => "u" + key);

export const VERTEX_SHADER = `attribute vec2 p; varying vec2 uv; void main(){ uv = p; gl_Position = vec4(p, 0., 1.); }`;

export const FRAGMENT_SHADER = `#extension GL_OES_standard_derivatives : enable
precision highp float;
varying vec2 uv;
uniform float uOp, t, energy, listen, uResY, eOpenL, eOpenR, eLookX, eLookY, eSmile, eScale, eTilt, eSquash;
uniform vec3 c0, c1, c2, c3, c4, c5;
uniform float ${UNIFORMS.join(", ")};
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
float fbm2(vec2 p){ return .65*n(p) + .35*n(p*2.03 + 17.); }
float fbm(vec2 p){ float v = 0., a = .5; mat2 r = mat2(.8,.6,-.6,.8); for (int k = 0; k < 4; k++){ v += a*n(p); p = r*p*2.02; a *= .5; } return v / .94; }
float field(vec2 p){ return mix(fbm2(p), fbm(p), uDetail); }
float band(float x, float c, float w){ w *= uSharp; return smoothstep(c - w, c + w, x); }
float quant(float x){ if (uPoster < 1.) return x; float q = x * uPoster; return (floor(q) + smoothstep(.45, .55, fract(q))) / uPoster; }
float shapeR(float a, float tt){
  float R = 1.;
  if (uShape < .5) R = 1.;
  else if (uShape < 1.5) { float c = abs(cos(a)), s = abs(sin(a)); R = .95 / pow(pow(c, 4.) + pow(s, 4.), .25); }
  else if (uShape < 2.5) { float c = abs(cos(a)), s = abs(sin(a)) / .66; R = .97 / pow(pow(c, 3.) + pow(s, 3.), 1./3.); }
  else if (uShape < 3.5) { R = .76 + .23*pow(max(sin(a), 0.), 7.) - .03*max(-sin(a), 0.); }
  else if (uShape < 4.5) { float c = cos(a), s = sin(a); R = .93 / length(vec2(c, s / (.84 + .1*s))); }
  else if (uShape < 5.5) { R = .82 + .1*(.5 + .5*cos(a*5. + .6)) + .02*cos(a*10.); }
  else if (uShape < 6.5) { R = .78 + .15*pow(.5 + .5*cos(a*6.), 1.5); }
  else if (uShape < 7.5) { float c5 = .5 + .5*cos(a*5. - 1.5708); R = .7 + .27*pow(c5, 1.4); }
  else if (uShape < 8.5) { float k = 1.0472; float m = mod(a + .5236, k) - .5236; R = mix(.9 * .866 / cos(m), .86, .25); }
  else if (uShape < 9.5) { float d = a + 2.25; d = mod(d + 3.14159, 6.28318) - 3.14159; R = .86 + .14*exp(-d*d / .02); }
  else if (uShape < 10.5) { R = .86 + .06*sin(3.*a + tt*.9) + .04*sin(5.*a - tt*1.3) + .03*sin(2.*a + tt*.5); }
  else if (uShape < 11.5) { float c = cos(a), s = sin(a); R = .78 / length(vec2(c, s / .6)); float u = abs(abs(a) - 3.14159); R += .3*exp(-pow(u - .36, 2.)/.022) - .07*exp(-pow(u - .72, 2.)/.012) - .12*exp(-u*u/.005); R = min(R, 1.); }
  else { R = .76 + .2*cos(a*5. - 1.5708) + .03*cos(a*10. - 3.14159); }
  R += uWobble * (.05*sin(3.*a + tt*1.1) + .035*sin(5.*a - tt*1.6));
  return R;
}
float eyeSdf(vec2 p, float open){
  float o = max(open, .07);
  vec2 q = vec2(p.x, p.y / o);
  float d;
  if (uEyeType < .5) d = length(vec2(q.x, max(abs(q.y) - .55, 0.))) - .36;
  else if (uEyeType < 1.5) d = length(q) - .5;
  else if (uEyeType < 2.5) d = (length(q / vec2(.46, .68)) - 1.) * .46;
  else if (uEyeType < 3.5) d = max(abs(length(q - vec2(0., -.5)) - .58) - .15, -(q.y + .32));
  else { vec2 b = abs(q) - vec2(.32, .38); d = length(max(b, 0.)) + min(max(b.x, b.y), 0.) - .16; }
  d *= o;
  float arc = max(abs(length(p - vec2(0., -.5)) - .58) - .15, -(p.y + .32));
  return mix(d, arc, eSmile);
}
vec3 hueShift(vec3 c, float a){ vec3 k = vec3(.57735); float ca = cos(a); return c*ca + cross(k, c)*sin(a) + k*dot(k, c)*(1. - ca); }
void main(){
  vec2 q0 = uv / uSize;
  q0 *= vec2(1. + eSquash*.5, 1. - eSquash);
  vec2 qe = q0;
  float r = length(q0);
  vec2 rv = q0;
  if (uShape > .5 || uWobble > 0.) {
    float cr = cos(uShapeRot), sr = sin(uShapeRot);
    vec2 qs = mat2(cr, sr, -sr, cr) * q0;
    r = length(qs) / shapeR(atan(qs.y, qs.x), t);
    vec2 gr = vec2(dFdx(r), dFdy(r));
    rv = normalize(mix(gr / max(length(gr), 1e-6), q0 / max(length(q0), 1e-6), (uShape > 6.5 && uShape < 7.5) || uShape > 10.5 ? .65 : .4) + 1e-6) * r;
  }
  float aaR = max(fwidth(r) * 1.2, .01);
  vec2 fc = gl_FragCoord.xy * (920. / uResY);
  // Outer glow
  if (r > 1.) {
    float ga = exp(-(r - 1.) * 9.) * uGlow * .55;
    gl_FragColor = vec4(mix(c2, c3, .4) * ga * uOp, ga * uOp); return;
  }
  float z = sqrt(max(0., 1. - r*r));
  vec2 s = q0 / mix(1., .85 + .25*z, uLens);
  float sp = t;
  vec2 dirF = vec2(cos(uFlowAng), sin(uFlowAng));
  vec2 nrmF = vec2(-dirF.y, dirF.x);
  vec2 pp = s;
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    if (fk >= uEddyN) break;
    float trip = mod(sp*.12 + fk*1.6, 3.2) - 1.6;
    vec2 vc = dirF*trip + nrmF*(fk == 0. ? .28 : -.32);
    vec2 d = pp - vc; float e = exp(-dot(d, d)*1.3 / (uEddySize*uEddySize));
    float fade = sin(3.14159 * (trip + 1.6) / 3.2); fade *= fade;
    float a2 = (fk == 0. ? 1.15 : -1.) * e * fade * uEddyStr;
    pp = vc + mat2(cos(a2), -sin(a2), sin(a2), cos(a2)) * d;
  }
  pp -= dirF * sp * .24 * uStream;
  float wa = uWarp + energy * uSpeakWarp;
  pp += wa * (vec2(fbm2(pp*1.3 + vec2(0., sp*.03)), fbm2(pp*1.3 + vec2(5.2, 1.7) - vec2(sp*.03, 0.))) - .5);
  vec2 q = pp * uScale;
  float f = quant(field(q*.85));
  float g = quant(field(q*.75 + vec2(7.1, 3.3)));
  float m = quant(field(q*.65 + vec2(13.7, 9.1)));
  vec3 col = mix(c1, c2, band(f, .5, .18));
  col = mix(col, c4, band(g, .56, .14) * .9 * min(uL4, 1.) );
  col = mix(col, c5, band(m, .57, .13) * .95 * min(uL5, 1.));
  col = mix(col, c3, band(f*.6 + g*.5, .73, .13) * .55 * uHi);
  if (uL4 > 1.) col = mix(col, c4, (uL4 - 1.) * band(g, .4, .2));
  if (uL5 > 1.) col = mix(col, c5, (uL5 - 1.) * band(m, .4, .2));
  // Ridges between paint layers
  float H = f*.6 + g*.4;
  if (uPoster >= 1. && uRidge > 0.) {
    float qv = H * uPoster; float fw = max(fwidth(qv), 1e-4);
    float dd = min(fract(qv), 1. - fract(qv)) / fw;
    float rl = 1. - smoothstep(.4, 1.6, dd);
    col = mix(col, c0, rl * uRidge * .45);
    H += rl * .15 * uRidge;
  }
  // Watercolour bleed: pigment pools where the colour changes fast
  if (uBleed > 0.) {
    float gr = length(vec2(dFdx(f), dFdy(f))) * uResY * .12;
    col = mix(col, col * mix(vec3(1.), c0 / max(max(c0.r, c0.g), max(c0.b, .01)), .5) * .82, clamp(gr, 0., 1.) * uBleed * .6);
  }
  // Fine lines
  float yS = dot(pp, nrmF) + .18*(f - .5)*(1. + uLineWob*3.);
  float xS = dot(pp, dirF);
  float grp = sin(yS*3.4*uLineGrpF + sp*.05);
  float rhythm = yS + .018*sin(yS*7. + sp*.06);
  float ph = rhythm * uLineDen + .94*(uLineDen/18.7)*sin(yS*3.4*uLineGrpF + sp*.05);
  float fw = max(fwidth(ph), 1e-4);
  float dpx = min(fract(ph), 1. - fract(ph)) / fw;
  float ln = 1. - smoothstep(.35*uLineW, 1.3*uLineW, dpx);
  ln *= smoothstep(.4, .22, fw);
  float lid = floor(ph);
  if (uLineStyle > .5 && uLineStyle < 1.5) { float dv = fract(xS*uLineDash + h(vec2(lid, 1.))); float fd = fwidth(xS*uLineDash); ln *= smoothstep(.45 - fd, .45 + fd, dv) * (1. - smoothstep(.95 - fd, .95, dv)); }
  if (uLineStyle > 1.5 && uLineStyle < 2.5) { float dv = abs(fract(xS*uLineDash*2. + h(vec2(lid, 2.))) - .5); float fd = fwidth(xS*uLineDash*2.); ln *= 1. - smoothstep(.12, .12 + fd*1.5, dv); }
  if (uLineStyle > 2.5) { ln *= smoothstep(.35, .65, n(vec2(xS*3.5, lid*.37))) * (.6 + .4*n(vec2(xS*20., lid))); }
  float cluster = mix(1., .5 + .5*smoothstep(-.6, .4, grp), uLineGrp);
  float fadeR = mix(1., smoothstep(1., .5, r), uLineFade);
  vec3 lc = uLineCol < .5 ? c3 : uLineCol < 1.5 ? c0 : uLineCol < 2.5 ? vec3(1.) : c1;
  col = mix(col, lc, clamp(ln * cluster * fadeR * uLines * .48, 0., 1.));
  // Dark edge
  vec2 dir = vec2(cos(.6 + sp*.2*uEdgeTurn), sin(.6 + sp*.2*uEdgeTurn));
  float side = smoothstep(-.65, .7, dot(q0, dir) + (g - .5)*1.1 + (m - .5)*.6);
  float edge = smoothstep(1. - .55*uEdgeWidth, 1.02, r + (g - .5)*.35) * side;
  col = mix(col, c0, clamp(edge * .95 * uEdge, 0., 1.));
  // Surface texture, fixed to the screen or following the flow
  float tex = 0.; vec2 tg = vec2(0.);
  vec2 tc = fc / uTexScale;
  if (uTex > .5 && uTex < 1.5) { tex = sin(tc.x*1.6)*sin(tc.y*1.6)*.5 + (n(tc*.7) - .5)*.6; }
  else if (uTex > 1.5 && uTex < 2.5) { tex = (fbm(tc*vec2(.08, .5)) - .5)*1.2 + (n(tc*.9) - .5)*.5; }
  else if (uTex > 2.5 && uTex < 3.5) { vec2 bp = vec2(xS*5./uBrushLen, yS*45./uBrushGap) / uTexScale; tex = (n(bp) - .5)*1.3 + (n(bp*vec2(.5, 2.3)) - .5)*.5 + (n(bp*vec2(6., 1.7)) - .5)*uBrushRough*1.2; }
  else if (uTex > 3.5 && uTex < 4.5) { tex = (n(tc*.35) - .5) + (n(tc*1.1) - .5)*.5; }
  else if (uTex > 4.5) { tex = sin((tc.x + tc.y)*1.2)*.5 + (n(tc*.5) - .5)*.4; }
  if (uTex > .5) { col *= 1. + tex * uTexAmt * .14; tg = vec2(dFdx(tex), dFdy(tex)) * uTexAmt * .5; }
  // Lighting
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
  col = hueShift(col, uHue) * uBright;
  col += (h(floor(fc / uGrainSize)) - .5) * uGrain;
  col = mix(col, c3, smoothstep(.8, 1., r) * listen * (.08 + .05*sin(t*2.2)) * uListenRing);
  // Eyes sit on the surface: they follow the squash but not the shape's rotation
  if (uEyes > .5) {
    float sz = uEyeSize * .2 * eScale;
    vec3 ec = uEyeCol < .5 ? vec3(1.) : uEyeCol < 1.5 ? vec3(.1, .09, .08) : uEyeCol < 2.5 ? c0 : c3;
    for (int k = 0; k < 2; k++) {
      float sgn = k == 0 ? -1. : 1.;
      vec2 ce = vec2(sgn * uEyeGap * .5, uEyeY) + vec2(eLookX, eLookY) * .1;
      vec2 p = (qe - ce) / sz;
      float tl = eTilt * sgn; p = mat2(cos(tl), -sin(tl), sin(tl), cos(tl)) * p;
      float d = eyeSdf(p, k == 0 ? eOpenL : eOpenR);
      float fwE = max(fwidth(d), 1e-4);
      float ea = 1. - smoothstep(-fwE, fwE, d);
      float halo = exp(-max(d, 0.) * 7.) * uEyeGlow * .45 * (1. - ea);
      col = mix(col, ec, clamp(ea + halo, 0., 1.));
    }
  }
  float alpha = (uShape > .5 || uWobble > 0.) ? 1. - smoothstep(1. - aaR - uEdgeSoft*.35, 1. + aaR*.2, r) : smoothstep(1., 1. - .01 - uEdgeSoft*.35, r);
  gl_FragColor = vec4(clamp(col, 0., 1.) * alpha * uOp, alpha * uOp);
}`;
