import type { AgentAvatarLook } from "./rule.js";

/**
 * A CSS background that approximates the avatar with its own palette, the
 * same size as the drawn orb. Use it for server rendering, before the first
 * paint, and where WebGL is unavailable.
 */
export function avatarBackground(look: AgentAvatarLook): string {
  const [edge, main, light, highlight] = look.palette;
  return (
    `radial-gradient(circle closest-side at 40% 36%, ${highlight} 0%, ${light} 22%, transparent 60%), ` +
    `radial-gradient(circle closest-side, ${main} 0%, ${main} 62%, ${edge} 86%, transparent 88%)`
  );
}
