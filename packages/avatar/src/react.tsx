import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import { mountAvatar, type AvatarHandle, type AvatarVariant } from "./avatar.js";
import { ENLARGED_CANVAS } from "./draw.js";
import { EMOTE_MS, type AvatarExpression, type AvatarState } from "./face.js";
import { avatarSvg } from "./fallback.js";
import { startBlinking } from "./blink.js";
import { acquireAvatarImage, canBlink } from "./image.js";

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

// Layout effects do nothing on the server; this keeps React from warning there.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const reduceQuery = "(prefers-reduced-motion: reduce)";
function subscribeReduced(onChange: () => void) {
  if (typeof matchMedia !== "function") return () => {};
  const q = matchMedia(reduceQuery);
  q.addEventListener?.("change", onChange);
  return () => q.removeEventListener?.("change", onChange);
}
const readReduced = () => typeof matchMedia === "function" && matchMedia(reduceQuery).matches;

interface Shown {
  key: string;
  url: string;
}

/**
 * The agent's avatar.
 *
 * Still avatars are an `<img>`: one shared image per seed, size, state and
 * expression, drawn by the WebGL renderer. A `<canvas>` is mounted only
 * while the avatar moves (animated, hovered, pressed or playing an event
 * expression) and is swapped back for the image once it settles. On the
 * server, before the image is ready and without WebGL, a still SVG with the
 * same outline and eyes is shown.
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
    onPointerEnter,
    onPointerMove,
    onPointerDown,
    ...rest
  },
  ref,
) {
  const systemReduced = useSyncExternalStore(subscribeReduced, readReduced, () => false);
  const reduced = reducedMotion ?? systemReduced;
  const enlarged = variant === "enlarged";
  // Below 32 px, enlarged, or with reduced motion, an avatar never moves: it is always an image.
  const canMove = !enlarged && !reduced && size >= 32;
  const pointer = canMove && (interactive ?? true);

  // A short expression shown as an image where the avatar cannot move.
  const [stillEmote, setStillEmote] = useState<AvatarExpression | null>(null);
  const shownExpression = stillEmote ?? expression;

  // engaged: a hover, press or event expression is playing on the canvas
  const [engaged, setEngaged] = useState(false);
  const [settled, setSettled] = useState(false);
  const live = canMove && (animated || engaged);

  // --- still image ---------------------------------------------------------
  const [shown, setShown] = useState<Shown | null>(null);
  const imageKey = useMemo(
    () => [agentId, size, state, shownExpression ?? "", variant].join("|"),
    [agentId, size, state, shownExpression, variant],
  );
  useEffect(() => {
    const image = acquireAvatarImage(agentId, { size, state, expression: shownExpression, variant });
    let current = true;
    void image.ready.then(async (url) => {
      if (!current || !url) return;
      // Decode first, so swapping images (or the canvas for an image) never flashes.
      if (typeof Image === "function") {
        const probe = new Image();
        probe.src = url;
        await probe.decode?.().catch(() => {});
      }
      if (current) setShown({ key: imageKey, url });
    });
    return () => {
      current = false;
      // Keep the image alive until the next one replaces it on screen.
      queueMicrotask(() => image.release());
    };
  }, [agentId, size, state, shownExpression, variant, imageKey]);
  const imageReady = shown?.key === imageKey;

  // --- blinks for small avatars, by swapping in the shut-eye image ----------
  const root = useRef<HTMLSpanElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const blinks =
    animated && !reduced && !enlarged && size < 32 && canBlink({ size, state, expression: shownExpression });
  const shownUrl = imageReady ? shown!.url : null;
  useEffect(() => {
    if (!blinks || !shownUrl) return;
    const shut = acquireAvatarImage(agentId, { size, state, expression: shownExpression, variant, blink: true });
    let stop: (() => void) | null = null;
    let current = true;
    void shut.ready.then(async (url) => {
      if (!current || !url || !root.current) return;
      if (typeof Image === "function") {
        const probe = new Image();
        probe.src = url;
        await probe.decode?.().catch(() => {});
      }
      if (!current || !root.current) return;
      stop = startBlinking(root.current, agentId, {
        set: (closed) => {
          if (img.current) img.current.src = closed ? url : shownUrl;
        },
      });
    });
    return () => {
      current = false;
      stop?.();
      shut.release();
    };
  }, [blinks, shownUrl, agentId, size, state, shownExpression, variant]);

  // Leave the canvas only once it has settled and the matching image is ready.
  useEffect(() => {
    if (engaged && settled && imageReady) setEngaged(false);
  }, [engaged, settled, imageReady]);

  // --- live canvas -----------------------------------------------------------
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<AvatarHandle | null>(null);
  const pendingEmote = useRef<[AvatarExpression, number] | null>(null);
  const [painted, setPainted] = useState(false);
  const options = { id: agentId, size, animated, state, expression, getVolume, interactive, variant, reducedMotion: reduced };
  const latest = useRef(options);
  latest.current = options;

  useIsomorphicLayoutEffect(() => {
    if (!live || !canvas.current) return;
    setSettled(false);
    const mounted = mountAvatar(canvas.current, {
      ...latest.current,
      onPaint: () => setPainted(true),
      onSettle: () => setSettled(true),
    });
    handle.current = mounted;
    if (pendingEmote.current) {
      mounted.emote(...pendingEmote.current);
      pendingEmote.current = null;
    }
    return () => {
      mounted.destroy();
      handle.current = null;
      setPainted(false);
    };
  }, [live]);

  useEffect(() => {
    if (!handle.current) return;
    setSettled(false);
    handle.current.update({ id: agentId, size, animated, state, expression, getVolume, interactive, variant, reducedMotion: reduced });
  }, [agentId, size, animated, state, expression, getVolume, interactive, variant, reduced]);

  const engage = useCallback(() => {
    if (!pointer) return;
    setSettled(false);
    setEngaged(true);
  }, [pointer]);

  useImperativeHandle(
    ref,
    () => ({
      emote: (expr, ms = EMOTE_MS) => {
        if (!canMove) {
          setStillEmote(expr);
          setTimeout(() => setStillEmote((e) => (e === expr ? null : e)), ms);
          return;
        }
        setSettled(false);
        if (handle.current) handle.current.emote(expr, ms);
        else {
          pendingEmote.current = [expr, ms];
          setEngaged(true);
        }
      },
    }),
    [canMove],
  );

  // --- markup --------------------------------------------------------------
  const idPrefix = useId();
  const svg = useMemo(
    () => (shown ? "" : avatarSvg(agentId, { size, state, expression: shownExpression, variant, idPrefix })),
    [shown, agentId, size, state, shownExpression, variant, idPrefix],
  );
  const css = enlarged ? size * ENLARGED_CANVAS : size;
  const offset = -(css - size) / 2;
  const layer: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: css,
    height: css,
    margin: offset || undefined,
    display: "block",
    pointerEvents: "none",
  };
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
  // While the canvas shows the avatar, the image underneath is hidden so nothing doubles up.
  const under: CSSProperties = live && painted ? { ...layer, visibility: "hidden" } : layer;
  const labelled = rest["aria-label"] !== undefined || rest["aria-labelledby"] !== undefined;
  return (
    <span
      role={labelled ? "img" : undefined}
      aria-hidden={labelled ? undefined : true}
      data-agent-avatar=""
      data-state={state}
      data-render={live ? "canvas" : shown ? "image" : "svg"}
      {...rest}
      ref={root}
      onPointerEnter={(e) => {
        engage();
        onPointerEnter?.(e);
      }}
      onPointerMove={(e) => {
        if (!live) engage();
        onPointerMove?.(e);
      }}
      onPointerDown={(e) => {
        engage();
        onPointerDown?.(e);
      }}
      style={box}
    >
      {shown ? (
        <img ref={img} src={shown.url} alt="" draggable={false} decoding="async" style={under} />
      ) : (
        <span aria-hidden="true" style={under} dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      {live ? <canvas ref={canvas} aria-hidden="true" style={{ ...layer, pointerEvents: "auto" }} /> : null}
    </span>
  );
});
