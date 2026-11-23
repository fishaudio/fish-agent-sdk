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
import { avatarLook } from "./rule.js";
import { startBlinking } from "./blink.js";
import { acquireAvatarImage, canBlink, peekAvatarImage, type AvatarImage } from "./image.js";
import { watchVisible } from "./visibility.js";

let emoteIds = 0;

const noopSubscribe = () => () => {};
const hasObserver = () => typeof IntersectionObserver === "function";
/** A soft dot in the avatar's main colour, the size of its body: the cheapest stand-in. */
function dotStyle(seed: string): CSSProperties {
  const { palette } = avatarLook(seed);
  return { borderRadius: "50%", background: `radial-gradient(circle at 36% 32%, ${palette[2]}, ${palette[1]} 70%)`, transform: "scale(0.82)" };
}

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

  const root = useRef<HTMLSpanElement>(null);
  const img = useRef<HTMLImageElement>(null);

  // Images are only made for avatars on (or near) the screen.
  // Once near, an avatar keeps its image: scrolling back and forth costs nothing more.
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!root.current) return;
    let stop: (() => void) | null = null;
    stop = watchVisible(root.current, (visible) => {
      if (!visible) return;
      setNear(true);
      stop?.();
      stop = null;
    });
    return () => stop?.();
  }, []);
  const [imageMissing, setImageMissing] = useState(false);

  // A short expression shown as an image where the avatar cannot move. Its time starts once it is on screen.
  const [stillEmote, setStillEmote] = useState<{ expr: AvatarExpression; ms: number; id: number } | null>(null);
  const [emoteSvg, setEmoteSvg] = useState(false);
  const shownExpression = stillEmote?.expr ?? expression;

  // engaged: a hover, press or event expression is playing on the canvas
  const [engaged, setEngaged] = useState(false);
  const [settled, setSettled] = useState(false);
  const live = canMove && (animated || engaged);

  // --- still image ---------------------------------------------------------
  const imageKey = [agentId, size, state, shownExpression ?? "", variant].join("|");
  // An image made earlier (say, before navigating away and back) shows on the very first render.
  const [shown, setShown] = useState<Shown | null>(() => {
    const url = peekAvatarImage(agentId, { size, state, expression: shownExpression, variant });
    return url ? { key: imageKey, url } : null;
  });
  const wanted = near || stillEmote !== null;
  useEffect(() => {
    if (!wanted) return;
    const image = acquireAvatarImage(agentId, {
      size,
      state,
      expression: shownExpression,
      variant,
      urgent: stillEmote !== null,
    });
    let current = true;
    const show = async (url: string | null) => {
      if (!current) return;
      if (!url) {
        // No WebGL: the SVG stands in for good.
        setImageMissing(true);
        return;
      }
      // Decode first, so swapping images (or the canvas for an image) never flashes.
      if (typeof Image === "function") {
        const probe = new Image();
        probe.src = url;
        await probe.decode?.().catch(() => {});
      }
      if (current) setShown((s) => (s?.key === imageKey && s.url === url ? s : { key: imageKey, url }));
    };
    if (image.url) void show(image.url);
    else void image.ready.then(show);
    return () => {
      current = false;
      // Keep the image alive until the next one replaces it on screen.
      queueMicrotask(() => image.release());
    };
  }, [wanted, agentId, size, state, shownExpression, variant, imageKey, stillEmote]);
  const imageReady = shown?.key === imageKey;

  // Event expressions on still avatars: the time starts when the expression is actually showing. If its image
  // is slow (over 300 ms), the SVG shows the expression meanwhile.
  const startEmoteClock = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!stillEmote) return;
    let end: ReturnType<typeof setTimeout> | null = null;
    const start = () => {
      if (end) return;
      end = setTimeout(() => {
        setStillEmote((e) => (e?.id === stillEmote.id ? null : e));
        setEmoteSvg(false);
      }, stillEmote.ms);
    };
    startEmoteClock.current = start;
    const fallback = setTimeout(() => {
      if (end) return;
      setEmoteSvg(true);
      start();
    }, 300);
    return () => {
      clearTimeout(fallback);
      if (end) clearTimeout(end);
      startEmoteClock.current = null;
    };
  }, [stillEmote]);
  useEffect(() => {
    if (stillEmote && imageReady) startEmoteClock.current?.();
  }, [stillEmote, imageReady]);

  // --- blinks for small avatars, by swapping in the shut-eye image ----------
  const blinks =
    animated && !reduced && !enlarged && size < 32 && canBlink({ size, state, expression: shownExpression });
  const shownUrl = imageReady ? shown!.url : null;
  useEffect(() => {
    if (!blinks || !shownUrl || !root.current) return;
    let shut: AvatarImage | null = null;
    let shutUrl: string | null = null;
    let current = true;
    const stop = startBlinking(root.current, agentId, {
      set: (closed) => {
        if (!closed) {
          if (img.current) img.current.src = shownUrl;
          return;
        }
        if (!shutUrl) {
          // The shut-eye frame is made just before the first blink, not up front.
          if (!shut) {
            shut = acquireAvatarImage(agentId, { size, state, expression: shownExpression, variant, blink: true });
            void shut.ready.then(async (url) => {
              if (!current || !url) return;
              if (typeof Image === "function") {
                const probe = new Image();
                probe.src = url;
                await probe.decode?.().catch(() => {});
              }
              shutUrl = url;
            });
          }
          return false;
        }
        if (img.current) img.current.src = shutUrl;
      },
    });
    return () => {
      current = false;
      stop();
      shut?.release();
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
          setEmoteSvg(false);
          setStillEmote({ expr, ms, id: ++emoteIds });
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
  // Server render and hydration always use the full SVG, so the markup matches. A client-side mount
  // (opening a page in an app) shows a light dot in the avatar's colour until its image is ready, so
  // long lists cost little to mount and scroll. The SVG also stands in where there is no WebGL, and
  // for an event expression whose image is slow.
  const hydrating = useSyncExternalStore(noopSubscribe, () => false, () => true);
  const showSvg = emoteSvg || (!shown && (hydrating || imageMissing || !hasObserver()));
  const showDot = !shown && !showSvg;
  const svg = useMemo(
    () => (showSvg ? avatarSvg(agentId, { size, state, expression: shownExpression, variant, idPrefix }) : ""),
    [showSvg, agentId, size, state, shownExpression, variant, idPrefix],
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
      data-render={live ? "canvas" : showSvg ? "svg" : showDot ? "placeholder" : "image"}
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
      {showDot ? (
        <span aria-hidden="true" style={{ ...under, ...dotStyle(agentId) }} />
      ) : !showSvg && shown ? (
        <img ref={img} src={shown.url} alt="" draggable={false} decoding="async" style={under} />
      ) : (
        <span aria-hidden="true" style={under} dangerouslySetInnerHTML={{ __html: svg }} />
      )}
      {live ? <canvas ref={canvas} aria-hidden="true" style={{ ...layer, pointerEvents: "auto" }} /> : null}
    </span>
  );
});
