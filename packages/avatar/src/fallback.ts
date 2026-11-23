// Still avatars without a canvas: SVG markup for server rendering, before the
// first paint, and anywhere WebGL is missing. Same outline, colours and eyes.
import { ENLARGED_CANVAS, ENLARGED_HALF, ERROR_FADE, SLOT_HALF } from "./draw.js";
import { Face, type AvatarExpression, type AvatarState, type EyePose } from "./face.js";
import { avatarLook, type AgentAvatarLook, type AvatarLook } from "./rule.js";
import { avatarShape } from "./shapes.js";

/**
 * A CSS background that approximates the avatar with its own palette.
 * Prefer {@link avatarSvg}, which keeps the outline and eyes.
 */
export function avatarBackground(look: AgentAvatarLook | AvatarLook): string {
  const [edge, main, light, highlight] = look.palette;
  return (
    `radial-gradient(circle closest-side at 40% 36%, ${highlight} 0%, ${light} 22%, transparent 60%), ` +
    `radial-gradient(circle closest-side, ${main} 0%, ${main} 62%, ${edge} 86%, transparent 88%)`
  );
}

export interface AvatarSvgOptions {
  /** Box size in CSS pixels. Defaults to 40. */
  size?: number;
  state?: AvatarState;
  expression?: AvatarExpression;
  variant?: "slot" | "enlarged";
  /**
   * Prefix for the gradient and outline ids inside the SVG. Ids are global
   * to the page, so give each copy of the same seed its own prefix (for
   * example from React's `useId`). Otherwise a copy inside a hidden
   * (`display: none`) container can break the others' gradients. Defaults to
   * an id derived from the seed.
   */
  idPrefix?: string;
}

const f = (x: number) => +x.toFixed(4);

function eyeMarkup(e: EyePose, color: string): string {
  const tf = `translate(${f(e.cx)} ${f(e.cy)}) rotate(${f(e.th)}) scale(${f(e.fz)} 1) rotate(${f(-e.th + e.roll)}) scale(${f(e.rr)})`;
  const parts: string[] = [];
  if (e.glyphs.oval > 0.5) {
    parts.push(`<ellipse rx="1" ry="1.76" transform="scale(1 ${f(Math.max(e.open, 0.03))})"/>`);
  }
  if (e.glyphs.happy > 0.5) parts.push(`<path fill="none" stroke="${color}" stroke-width=".95" d="M-1.1 .45Q0 -1.25 1.1 .45"/>`);
  if (e.glyphs.closed > 0.5) parts.push(`<path fill="none" stroke="${color}" stroke-width=".8" d="M-1.15 0Q0 .75 1.15 0"/>`);
  return `<g transform="${tf}">${parts.join("")}</g>`;
}

/**
 * The avatar as SVG markup, still. Pure and SSR-safe: the same seed and
 * options always give the same string. Pass a unique `idPrefix` per copy
 * when one seed can appear more than once on a page.
 */
export function avatarSvg(seed: string, options: AvatarSvgOptions = {}): string {
  const { size = 40, state = "idle", expression, variant = "slot", idPrefix } = options;
  const id = idPrefix ? `fa-av-${idPrefix.replace(/[^A-Za-z0-9_-]/g, "_")}` : `fa-av-${avatarLook(seed).n}`;
  // The markup only depends on the look, so it is built once and only the ids are swapped in.
  const cacheKey = [seed, size, state, expression ?? "", variant].join("\u0000");
  let base = svgCache.get(cacheKey);
  if (base === undefined) {
    base = buildSvg(seed, size, state, expression, variant);
    svgCache.set(cacheKey, base);
    if (svgCache.size > SVG_CACHE_LIMIT) svgCache.delete(svgCache.keys().next().value!);
  }
  return base.split(ID_TOKEN).join(id);
}

const ID_TOKEN = "\u0001id\u0001";
const SVG_CACHE_LIMIT = 500;
const svgCache = new Map<string, string>();

function buildSvg(
  seed: string,
  size: number,
  state: AvatarState,
  expression: AvatarExpression | undefined,
  variant: "slot" | "enlarged",
): string {
  const look = avatarLook(seed);
  const shape = avatarShape(look.shape);
  const enlarged = variant === "enlarged";
  const half = enlarged ? ENLARGED_HALF : SLOT_HALF;
  const css = f(enlarged ? size * ENLARGED_CANVAS : size);
  const pose = new Face(look, {
    size,
    state,
    expression,
    animated: false,
    reducedMotion: true,
    interactive: false,
  }).step(0);
  const [edge, main, light] = look.palette;
  const id = ID_TOKEN;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-half} ${-half} ${2 * half} ${2 * half}" width="${css}" height="${css}" aria-hidden="true" focusable="false">`,
    `<defs><radialGradient id="${id}-a" cx=".32" cy=".28" r=".85"><stop offset="0" stop-color="${light}"/><stop offset=".7" stop-color="${main}"/></radialGradient>`,
    `<radialGradient id="${id}-e" cx=".3" cy=".25" r="1.05"><stop offset=".62" stop-color="${edge}" stop-opacity="0"/><stop offset="1" stop-color="${edge}" stop-opacity=".75"/></radialGradient><path id="${id}-p" d="${shape.path}"/></defs>`,
  ];
  if (!pose.bodyHidden) {
    const op = 1 - ERROR_FADE * pose.dim;
    out.push(
      `<g${op < 1 ? ` opacity="${f(op)}"` : ""}><use href="#${id}-p" fill="url(#${id}-a)"/><use href="#${id}-p" fill="url(#${id}-e)"/></g>`,
    );
    if (pose.eyesOpacity > 0.5) {
      out.push(
        `<g fill="${look.eyeColor}" stroke-linecap="round" stroke-linejoin="round">${pose.eyes.map((e) => eyeMarkup(e, look.eyeColor)).join("")}</g>`,
      );
    }
  }
  if (pose.bars > 0.5) {
    out.push(
      `<g fill="${main}">${[-0.5, -0.11, 0.28]
        .map((x, i) => {
          const h = pose.barHeights[i]!;
          return `<rect x="${x}" y="${f(-h / 2)}" width=".22" height="${f(h)}" rx=".11"/>`;
        })
        .join("")}</g>`,
    );
  }
  out.push("</svg>");
  return out.join("");
}
