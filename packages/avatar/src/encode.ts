// The image worker, seen from the page. Still frames are drawn and encoded
// entirely in one shared worker (its own WebGL on an OffscreenCanvas). Where
// the worker cannot use WebGL, frames are drawn on the page and only the
// PNG encoding goes to the worker. Where there is no worker at all (or a
// page's policy blocks it), encoding falls back to the main thread, one
// image per idle slice.

import WORKER_SOURCE from "./still-worker.gen.js";
import type { StillJob } from "./still.js";

type Done = (blob: Blob | null) => void;

let worker: Worker | null | undefined;
const waiting = new Map<number, { done: Done; fallback: () => void }>();
/** Whether the worker can draw with WebGL itself: unknown until the first render answers. */
let workerRenders: boolean | undefined;
let nextId = 0;

/** Whether the worker draws images itself (true), cannot (false), or has not answered yet (undefined). */
export function workerCanRender(): boolean | undefined {
  return workerRenders;
}

/** Which path encodes images: `worker`, or `main` (idle slices on the main thread). */
export function encoderPath(): "worker" | "main" {
  return getWorker() ? "worker" : "main";
}

function failWorker() {
  worker?.terminate();
  worker = null;
  const stuck = [...waiting.values()];
  waiting.clear();
  for (const w of stuck) w.fallback();
}

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  worker = null;
  try {
    if (
      typeof Worker !== "function" ||
      typeof OffscreenCanvas !== "function" ||
      typeof Blob !== "function" ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      return null;
    }
    const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
    const w = new Worker(url);
    w.onmessage = (e: MessageEvent<{ id: number; blob: Blob | null; failed?: boolean }>) => {
      const job = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (!job) return;
      if (e.data.failed) job.fallback();
      else job.done(e.data.blob);
    };
    w.onerror = (e) => {
      e.preventDefault?.();
      failWorker();
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** Test hook: forget the worker so the next call decides again. */
export function resetEncoder(): void {
  worker?.terminate();
  worker = undefined;
  workerRenders = undefined;
  waiting.clear();
  mainQueue.length = 0;
  mainScheduled = false;
}

// --- main-thread fallback: one encode per idle slice -------------------------

const SLICE_MS = 4;
const mainQueue: Array<{ canvas: HTMLCanvasElement; done: Done }> = [];
let mainScheduled = false;

type IdleDeadline = { timeRemaining(): number };
const idle = (cb: (d: IdleDeadline) => void) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: (d: IdleDeadline) => void, o?: { timeout: number }) => void })
    .requestIdleCallback;
  if (typeof ric === "function") ric(cb, { timeout: 500 });
  else setTimeout(() => cb({ timeRemaining: () => SLICE_MS }), 16);
};

function pumpMain() {
  if (mainScheduled) return;
  mainScheduled = true;
  idle((deadline) => {
    mainScheduled = false;
    // One image per idle slice.
    void deadline;
    const job = mainQueue.shift();
    if (job) {
      if (typeof job.canvas.toBlob === "function") job.canvas.toBlob((b) => job.done(b), "image/png");
      else job.done(null);
    }
    if (mainQueue.length) pumpMain();
  });
}

function encodeOnMain(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((done) => {
    mainQueue.push({ canvas, done });
    pumpMain();
  });
}

/** Encodes a drawn square canvas as PNG, off the main thread when possible. */
export function encodePng(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Promise<Blob | null> {
  const w = getWorker();
  if (!w) return encodeOnMain(canvas);
  let pixels: ImageData;
  try {
    pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return encodeOnMain(canvas);
  }
  return new Promise((done) => {
    const id = ++nextId;
    waiting.set(id, { done, fallback: () => void encodeOnMain(canvas).then(done) });
    try {
      w.postMessage({ type: "encode", id, w: canvas.width, h: canvas.height, buf: pixels.data.buffer }, [pixels.data.buffer]);
    } catch {
      waiting.delete(id);
      void encodeOnMain(canvas).then(done);
    }
  });
}

/**
 * Draws and encodes a still frame in the worker. Resolves with the PNG, or
 * "unsupported" when there is no worker or it cannot use WebGL (then draw
 * on the page instead).
 */
export function renderInWorker(job: StillJob): Promise<Blob | null | "unsupported"> {
  const w = workerRenders === false ? null : getWorker();
  if (!w) return Promise.resolve("unsupported");
  return new Promise((done) => {
    const id = ++nextId;
    waiting.set(id, {
      done: (blob) => {
        workerRenders = true;
        done(blob);
      },
      fallback: () => {
        // The worker has no WebGL (or failed): draw on the page from now on.
        workerRenders = false;
        done("unsupported");
      },
    });
    try {
      w.postMessage({ type: "render", id, job });
    } catch {
      waiting.delete(id);
      done("unsupported");
    }
  });
}
