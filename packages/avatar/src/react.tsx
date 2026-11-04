import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import { mountAvatar, type AvatarHandle, type AvatarVariant } from "./avatar.js";
import { ENLARGED_CANVAS } from "./draw.js";
import { EMOTE_MS, type AvatarExpression, type AvatarState } from "./face.js";
import { avatarSvg } from "./fallback.js";

export type { AvatarExpression, AvatarState, AvatarVariant };

export interface AgentAvatarProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  /** The seed: an agent id, or a stable template key. The same seed always draws the same avatar. */
  agentId: string;
  /** Size in CSS pixels. Defaults to 40. What the avatar does depends on it (see the README's size matrix). */
  size?: number;
  /** Keep it alive: blinks, look-around, and from 48 px the flowing body. Off by default. */
  animated?: boolean;
  /** Call state. Defaults to `idle`. */
  state?: AvatarState;
  /** A lasting expression that replaces the state's own one. */
  expression?: AvatarExpression;
  /** The agent's output level, 0–1, read every frame while speaking. */
  getVolume?: () => number;
  /** From 32 px: look at the pointer on hover, press to 95%. Defaults to true from 32 px. */
  interactive?: boolean;
  /** `enlarged` for dialogs, menus and sheets: still, 1.25× the slot, body about 78% of the slot. */
  variant?: AvatarVariant;
  /** Force reduced motion on or off. Defaults to the user's setting. */
  reducedMotion?: boolean;
}

export interface AgentAvatarHandle {
  /** Plays an event expression (about 1.3 s by default), then returns to the current state. */
  emote(expression: AvatarExpression, ms?: number): void;
}

/**
 * The agent's avatar. Renders a still SVG on the server and until the first
 * canvas frame, so it never flashes empty, and keeps it where canvas is
 * unavailable.
 */
export const AgentAvatar = forwardRef<AgentAvatarHandle, AgentAvatarProps>(function AgentAvatar(
  {
    agentId,
    size = 40,
    animated = false,
    state = "idle",
    expression,
    getVolume,
    interactive,
    variant = "slot",
    reducedMotion,
    style,
    ...rest
  },
  ref,
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<AvatarHandle | null>(null);
  const [painted, setPainted] = useState(false);
  const options = { id: agentId, size, animated, state, expression, getVolume, interactive, variant, reducedMotion };
  const latest = useRef(options);
  latest.current = options;

  useImperativeHandle(
    ref,
    () => ({
      emote: (expr, ms = EMOTE_MS) => handle.current?.emote(expr, ms),
    }),
    [],
  );

  useEffect(() => {
    const mounted = mountAvatar(canvas.current!, { ...latest.current, onPaint: () => setPainted(true) });
    handle.current = mounted;
    return () => {
      mounted.destroy();
      handle.current = null;
    };
  }, []);

  useEffect(() => {
    handle.current?.update({ id: agentId, size, animated, state, expression, getVolume, interactive, variant, reducedMotion });
  }, [agentId, size, animated, state, expression, getVolume, interactive, variant, reducedMotion]);

  const svg = useMemo(
    () => (painted ? "" : avatarSvg(agentId, { size, state, expression, variant })),
    [painted, agentId, size, state, expression, variant],
  );

  const css = variant === "enlarged" ? size * ENLARGED_CANVAS : size;
  const offset = -(css - size) / 2;
  const layer: CSSProperties = { position: "absolute", left: 0, top: 0, width: css, height: css, display: "block" };
  const box: CSSProperties = {
    position: "relative",
    display: "inline-block",
    flex: "none",
    width: size,
    height: size,
    lineHeight: 0,
    verticalAlign: "middle",
    ...style,
  };
  const labelled = rest["aria-label"] !== undefined || rest["aria-labelledby"] !== undefined;
  return (
    <span
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      data-agent-avatar=""
      data-state={state}
      {...rest}
      style={box}
    >
      {svg ? (
        <span
          aria-hidden="true"
          style={{ ...layer, margin: offset || undefined, pointerEvents: "none" }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : null}
      <canvas ref={canvas} aria-hidden="true" style={layer} />
    </span>
  );
});
