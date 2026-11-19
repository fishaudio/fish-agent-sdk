import { useEffect, useRef, useState, type CanvasHTMLAttributes, type CSSProperties } from "react";
import { mountAvatar, type AvatarHandle, type AvatarState } from "./avatar.js";
import { avatarBackground } from "./fallback.js";
import { agentAvatar } from "./rule.js";

export interface AgentAvatarProps
  extends Omit<CanvasHTMLAttributes<HTMLCanvasElement>, "children" | "width" | "height"> {
  /** The agent id. The same id always draws the same avatar. */
  agentId: string;
  /** Size in CSS pixels. Eyes appear from 64. Defaults to 40. */
  size?: number;
  /** Keep the orb flowing. Off by default. */
  animated?: boolean;
  /** Call state. Only used when animated. */
  state?: AvatarState;
  /** The agent's output level, 0–1, read every frame while speaking. */
  getVolume?: () => number;
}

/**
 * The agent's avatar. Static by default. Before the first frame, and where
 * WebGL is unavailable, it shows a gradient in the avatar's colours.
 */
export function AgentAvatar({
  agentId,
  size = 40,
  animated = false,
  state = "idle",
  getVolume,
  style,
  ...rest
}: AgentAvatarProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<AvatarHandle | null>(null);
  const [painted, setPainted] = useState(false);
  const options = { id: agentId, size, animated, state, getVolume };
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const mounted = mountAvatar(canvas.current!, { ...latest.current, onPaint: () => setPainted(true) });
    handle.current = mounted;
    return () => {
      mounted.destroy();
      handle.current = null;
    };
  }, []);

  useEffect(() => {
    handle.current?.update({ id: agentId, size, animated, state, getVolume });
  }, [agentId, size, animated, state, getVolume]);

  const box: CSSProperties = {
    display: "inline-block",
    flex: "none",
    width: size,
    height: size,
    background: painted ? undefined : avatarBackground(agentAvatar(agentId, size)),
    ...style,
  };
  const labelled = rest["aria-label"] !== undefined || rest["aria-labelledby"] !== undefined;
  return (
    <canvas ref={canvas} role={labelled ? "img" : undefined} aria-hidden={labelled ? undefined : true} {...rest} style={box} />
  );
}
