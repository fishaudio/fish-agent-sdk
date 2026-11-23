import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PanResponder, View, type LayoutRectangle, type ViewStyle } from "react-native";

/** Where a dragged launcher rests: a side, and a distance from the top or bottom edge. */
export interface DragPosition {
  side: "left" | "right";
  edge: "top" | "bottom";
  /** Distance from `edge` to the launcher, in points, insets included. */
  distance: number;
}

export interface DragBounds {
  width: number;
  height: number;
  /** Inner margin on each side: theme offset plus the safe-area inset. */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Size {
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** Movement, in points, before a touch counts as a drag instead of a tap. */
const DRAG_SLOP = 6;
/** Length of the glide to the snapped side after release. */
const SNAP_MS = 200;

/** Top-left corner of a launcher of `size` resting at `position`, kept inside `bounds`. */
export function restingPoint(position: DragPosition, bounds: DragBounds, size: Size): Point {
  const x = position.side === "left" ? bounds.left : bounds.width - bounds.right - size.width;
  const minY = bounds.top;
  const maxY = Math.max(minY, bounds.height - bounds.bottom - size.height);
  const y = position.edge === "top" ? position.distance : bounds.height - position.distance - size.height;
  return { x, y: Math.min(Math.max(y, minY), maxY) };
}

/** Where a launcher released at `rect` (container coordinates) snaps to. */
export function snapPosition(rect: LayoutRectangle, bounds: DragBounds): DragPosition {
  const side = rect.x + rect.width / 2 < bounds.width / 2 ? "left" : "right";
  const centerY = rect.y + rect.height / 2;
  if (centerY < bounds.height / 2) {
    return { side, edge: "top", distance: Math.max(bounds.top, rect.y) };
  }
  return { side, edge: "bottom", distance: Math.max(bounds.bottom, bounds.height - rect.y - rect.height) };
}

interface DraggableProps {
  /** Resting style until the launcher is first dragged (the configured corner). */
  cornerStyle: ViewStyle;
  position: DragPosition | null;
  bounds: DragBounds | null;
  enabled: boolean;
  onDragStart(): void;
  onDragEnd(position: DragPosition): void;
  /**
   * Size of the launcher itself when the wrapper also holds something that
   * goes away on drag (the proactive bubble beside the button).
   */
  anchorSize?: Size;
  children: ReactNode;
}

/**
 * Wraps the launcher (button or minimized pill). Taps reach the children;
 * a move past the slop takes over the touch and moves the launcher, which
 * glides to the nearer side on release.
 *
 * The position lives in React state only. Animated values that bypass React
 * to move a layout prop fight React's own commits under the new architecture,
 * and the launcher flickers between the two places.
 */
export function Draggable({
  cornerStyle,
  position,
  bounds,
  enabled,
  onDragStart,
  onDragEnd,
  anchorSize,
  children,
}: DraggableProps) {
  const [point, setPoint] = useState<Point | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  const current = useRef<Point>({ x: 0, y: 0 }); // the launcher's top-left once placed
  const cornerRect = useRef<LayoutRectangle | null>(null);
  const start = useRef<Point>({ x: 0, y: 0 });
  const busy = useRef(false); // dragging or gliding: the gesture owns the point
  const frame = useRef<number | null>(null);
  const latest = useRef({ bounds, size, onDragStart, onDragEnd, cornerStyle, anchorSize });
  latest.current = { bounds, size, onDragStart, onDragEnd, cornerStyle, anchorSize };

  const placedRef = useRef(false);
  const place = (next: Point) => {
    current.current = next;
    placedRef.current = true;
    setPoint(next);
  };
  const stopGlide = () => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
  };
  useEffect(() => stopGlide, []);

  // Rest at the remembered position; follow size and bounds changes (pill vs button, rotation).
  const rest = position && bounds && size ? restingPoint(position, bounds, size) : null;
  useEffect(() => {
    if (rest && !busy.current) {
      place(rest);
    }
  }, [rest?.x, rest?.y]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Capture, so a drag that starts on the button's Pressable still moves the launcher.
        onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > DRAG_SLOP || Math.abs(g.dy) > DRAG_SLOP,
        onPanResponderGrant: () => {
          busy.current = true;
          stopGlide();
          const corner = cornerRect.current;
          if (corner && !placedRef.current) {
            // First drag from the corner: start from the launcher itself, anchored the
            // way the corner is, since the bubble beside it goes away now.
            const a = latest.current.anchorSize ?? corner;
            const c = latest.current.cornerStyle;
            current.current = {
              x: c.right !== undefined ? corner.x + corner.width - a.width : corner.x,
              y: c.bottom !== undefined ? corner.y + corner.height - a.height : corner.y,
            };
          }
          start.current = { ...current.current };
          latest.current.onDragStart();
        },
        onPanResponderMove: (_, g) => {
          place({ x: start.current.x + g.dx, y: start.current.y + g.dy });
        },
        onPanResponderRelease: () => {
          const { bounds: b, size: s, onDragEnd: done } = latest.current;
          if (!b || !s) {
            busy.current = false;
            return;
          }
          const next = snapPosition({ ...current.current, ...s }, b);
          const from = { ...current.current };
          const to = restingPoint(next, b, s);
          const began = Date.now();
          const step = () => {
            const t = Math.min(1, (Date.now() - began) / SNAP_MS);
            const k = 1 - (1 - t) ** 3; // ease out
            place({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
            if (t < 1) {
              frame.current = requestAnimationFrame(step);
            } else {
              frame.current = null;
              busy.current = false;
            }
          };
          frame.current = requestAnimationFrame(step);
          done(next);
        },
        onPanResponderTerminate: () => {
          busy.current = false;
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );

  return (
    <View
      {...(enabled ? responder.panHandlers : {})}
      onLayout={(e) => {
        const { x, y, width, height } = e.nativeEvent.layout;
        if (point === null) {
          // Still in the corner: remember where, so the first drag starts from there.
          cornerRect.current = { x, y, width, height };
        }
        setSize((old) => (old && old.width === width && old.height === height ? old : { width, height }));
      }}
      style={
        point
          ? { position: "absolute", left: point.x, top: point.y }
          : // A remembered position waits for the size before showing, instead of flashing in the corner.
            [cornerStyle, position ? { opacity: 0 } : null]
      }
    >
      {children}
    </View>
  );
}
