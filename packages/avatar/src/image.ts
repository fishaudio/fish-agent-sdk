// Still avatars as images. A canvas per avatar is costly to paint and
// composite in long lists, so still avatars are drawn once by the shared
// WebGL renderer into a PNG and shown with <img>. Every copy of the same
// seed, size, state and expression shares one image.
//
// Images are made on demand, never all at once: requests queue up, a few
// frames are drawn per idle slice within a small time budget, and PNG
// encoding happens in a worker (see encode.ts). Callers only ask for
// avatars that are on screen.
import { ENLARGED_CANVAS } from "./draw.js";
import { encodePng, encoderPath, renderInWorker, workerCanRender } from "./encode.js";
import type { AvatarExpression, AvatarState } from "./face.js";
import { hasWebGL, prepareRenderer } from "./renderer.js";
import { stillFrame, stillPose, type StillJob } from "./still.js";

export interface AvatarImageOptions {
  /** Slot size in CSS pixels. Defaults to 40. */
  size?: number;
  state?: AvatarState;
  expression?: AvatarExpression;
  /** The blink frame: same avatar with the eyes shut. Only differs where the eyes are open ovals. */
  blink?: boolean;
  variant?: "slot" | "enlarged";
  /** Device pixel ratio to render at. Defaults to the screen's, capped at 2. */
  dpr?: number;
  /** Jump the queue, for an image someone is waiting to see (an event expression). */
  urgent?: boolean;
}

export interface AvatarImage {
  /** Cache key: seed, pixel size, state, expression, variant and blink. */
  key: string;
  /** The image URL once rendered, else null. */
  url: string | null;
  /** Resolves with the URL, or null where WebGL is unavailable. */
  ready: Promise<string | null>;
  /** Width and height of the image in CSS pixels (1.25× the slot when enlarged). */
  cssSize: number;
  /** Gives the image back. Unused images are kept for a while, then freed. */
  release(): void;
}

interface Entry {
  key: string;
  seed: string;
  size: number;
  px: number;
  options: AvatarImageOptions;
  url: string | null;
  ready: Promise<string | null>;
  resolve: (url: string | null) => void;
  refs: number;
  status: "queued" | "drawing" | "done";
}

/** Unused images kept around for reuse (for example when a page is opened again) before their memory is freed. */
export const IDLE_IMAGE_LIMIT = 256;
/** Main-thread time spent drawing frames per slice, in milliseconds. */
export const DRAW_BUDGET_MS = 4;

const entries = new Map<string, Entry>();
/** Keys with no users, oldest first. */
const idle = new Set<string>();
const queue: Entry[] = [];
let renders = 0;
let pumping = false;

function revoke(entry: Entry) {
  if (entry.url && entry.url.startsWith("blob:") && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(entry.url);
  }
}

function trim(limit: number) {
  for (const key of idle) {
    if (idle.size <= limit) break;
    idle.delete(key);
    const entry = entries.get(key);
    if (entry && entry.refs === 0) {
      entries.delete(key);
      revoke(entry);
    }
  }
}

/** Whether a still pose has eyes that can blink (open ovals, not happy or sleepy, not connecting). */
const blinkable = new Map<string, boolean>();
export function canBlink(o: Pick<AvatarImageOptions, "size" | "state" | "expression">): boolean {
  const key = `${o.size ?? 40}|${o.state ?? "idle"}|${o.expression ?? ""}`;
  let yes = blinkable.get(key);
  if (yes === undefined) {
    const pose = stillPose("x", { size: o.size ?? 40, state: o.state, expression: o.expression });
    yes = !pose.bodyHidden && pose.eyesOpacity > 0.5 && pose.eyes.every((e) => e.glyphs.oval > 0.5);
    blinkable.set(key, yes);
  }
  return yes;
}

function finish(entry: Entry, url: string | null) {
  entry.status = "done";
  if (entries.get(entry.key) === entry) {
    entry.url = url;
    // Released while it was being made: it joins the unused images.
    if (entry.refs === 0) {
      idle.add(entry.key);
      trim(IDLE_IMAGE_LIMIT);
    }
  } else if (url) revoke({ ...entry, url });
  entry.resolve(url);
}

const toUrl = (blob: Blob | null) =>
  blob && typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : null;

function jobOf(entry: Entry): StillJob {
  const o = entry.options;
  return { seed: entry.seed, size: entry.size, px: entry.px, state: o.state, expression: o.expression, variant: o.variant, blink: o.blink };
}

/** Draws one image on the page (a few milliseconds of main thread) and hands the encoding off. */
function drawOnPage(entry: Entry) {
  entry.status = "drawing";
  if (!hasWebGL()) return finish(entry, null);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = entry.px;
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!ctx || !stillFrame(ctx, jobOf(entry))) return finish(entry, null);
  renders++;
  void encodePng(canvas, ctx).then((blob) => finish(entry, toUrl(blob)));
}

/** Hands one image to the worker, which draws and encodes it off the main thread. */
function drawInWorker(entry: Entry) {
  entry.status = "drawing";
  inFlight++;
  void renderInWorker(jobOf(entry)).then((result) => {
    inFlight--;
    if (result === "unsupported") {
      // The worker cannot draw: queue it again for the page.
      entry.status = "queued";
      queue.unshift(entry);
    } else {
      renders++;
      finish(entry, toUrl(result));
    }
    pump();
  });
}

let inFlight = 0;
/** Images the worker works on at once. */
const MAX_IN_FLIGHT = 4;

type IdleDeadline = { timeRemaining(): number; didTimeout?: boolean };
function nextSlice(cb: () => void) {
  const ric = (globalThis as { requestIdleCallback?: (cb: (d: IdleDeadline) => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof ric === "function") ric(() => cb(), { timeout: 120 });
  else setTimeout(cb, 0);
}

const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

let rendererReady = false;
function pump() {
  if (pumping) return;
  pumping = true;
  const onPage = workerCanRender() === false || encoderPath() === "main";
  if (onPage && !rendererReady) {
    // Compile the shaders in the background first, so the first image does not stall the page.
    void prepareRenderer().then(() => {
      rendererReady = true;
      pumping = false;
      pump();
    });
    return;
  }
  nextSlice(() => {
    pumping = false;
    const start = clock();
    // At least one frame per slice, then as many as fit in the budget.
    const worker = !(workerCanRender() === false || encoderPath() === "main");
    while (queue.length && (!worker || inFlight < MAX_IN_FLIGHT)) {
      const entry = queue.shift()!;
      if (entry.refs === 0) {
        // Nobody wants it any more (scrolled away, unmounted): drop it unmade.
        if (entries.get(entry.key) === entry) entries.delete(entry.key);
        idle.delete(entry.key);
        entry.resolve(null);
        continue;
      }
      if (worker) drawInWorker(entry);
      else if (typeof document === "undefined") finish(entry, null);
      else drawOnPage(entry);
      if (clock() - start >= DRAW_BUDGET_MS) break;
    }
    // With the worker busy, the next pump comes when one of its images is done.
    if (queue.length && (!worker || inFlight < MAX_IN_FLIGHT)) pump();
  });
}

function keyFor(seed: string, options: AvatarImageOptions) {
  const size = options.size ?? 40;
  const enlarged = options.variant === "enlarged";
  const cssSize = enlarged ? size * ENLARGED_CANVAS : size;
  const dpr = Math.min(2, options.dpr ?? ((typeof devicePixelRatio === "number" && devicePixelRatio) || 1));
  const px = Math.max(1, Math.round(cssSize * dpr));
  const key = [seed, size, px, options.state ?? "idle", options.expression ?? "", enlarged ? "e" : "s", options.blink ? "b" : ""].join(
    "\u0000",
  );
  return { key, size, px, cssSize };
}

/** The image's URL if it is already made, without asking for it. Lets a remounted avatar show it on its first render. */
export function peekAvatarImage(seed: string, options: AvatarImageOptions = {}): string | null {
  return entries.get(keyFor(seed, options).key)?.url ?? null;
}

/**
 * A still image of the avatar, shared by every caller with the same seed,
 * size, state, expression and variant. Ask only for avatars on screen: the
 * image is queued and made in small idle slices, with encoding off the main
 * thread. Call `release()` when it is no longer shown; images released
 * before they are made are never made. `url` stays null (and `ready`
 * resolves to null) where WebGL is unavailable: use {@link avatarSvg} there.
 */
export function acquireAvatarImage(seed: string, options: AvatarImageOptions = {}): AvatarImage {
  const { key, size, px, cssSize } = keyFor(seed, options);
  let entry = entries.get(key);
  if (!entry) {
    let resolve!: (url: string | null) => void;
    const ready = new Promise<string | null>((r) => (resolve = r));
    entry = { key, seed, size, px, options, url: null, ready, resolve, refs: 0, status: "queued" };
    entries.set(key, entry);
    if (options.urgent) queue.unshift(entry);
    else queue.push(entry);
    pump();
  } else if (options.urgent && entry.status === "queued") {
    const i = queue.indexOf(entry);
    if (i > 0) {
      queue.splice(i, 1);
      queue.unshift(entry);
    }
  }
  entry.refs++;
  idle.delete(key);
  const held = entry;
  let released = false;
  return {
    key,
    get url() {
      return held.url;
    },
    ready: held.ready,
    cssSize,
    release() {
      if (released) return;
      released = true;
      held.refs--;
      if (held.refs === 0 && entries.get(key) === held && held.status === "done") {
        idle.add(key);
        trim(IDLE_IMAGE_LIMIT);
      }
    },
  };
}

/** Frees every image that nobody is using. */
export function clearAvatarImages(): void {
  trim(0);
}

/** Cache and queue counters, for tests and diagnostics. */
export function avatarImageStats(): { images: number; idle: number; renders: number; queued: number } {
  return { images: entries.size, idle: idle.size, renders, queued: queue.length };
}

/** Test hook: forgets every image and anything queued. */
export function resetAvatarImages(): void {
  for (const e of queue) e.resolve(null);
  queue.length = 0;
  for (const e of entries.values()) revoke(e);
  entries.clear();
  idle.clear();
  pumping = false;
  rendererReady = false;
  inFlight = 0;
}
