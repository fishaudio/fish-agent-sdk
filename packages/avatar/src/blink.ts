// Blinks for small still avatars without a canvas: their <img> briefly shows
// the shut-eye frame. One timer chain serves the whole page (no
// requestAnimationFrame), only visible avatars take part, and only a few
// blink at the same moment so a long list never swaps images all at once.
import { avatarIndex } from "./rule.js";

/** How long the eyes stay shut, in milliseconds. */
export const BLINK_SHUT_MS = 140;
/** At most this many avatars blink at the same moment. */
export const MAX_BLINKING = 3;
/** Time between blinks, as in the rules: 2–5.5 s, one in five a double blink. */
const GAP_MIN = 2000;
const GAP_MAX = 5500;
const DOUBLE_CHANCE = 0.2;
const DOUBLE_GAP_MS = 120;
/** No new blinks while the page scrolls, and for this long after. */
const SCROLL_QUIET_MS = 300;
/** Timers are coalesced to at least this spacing. */
const TICK_MS = 40;

export interface Blinker {
  /**
   * Shut (true) or open (false) the eyes. Return false from a shut call when
   * the shut-eye frame is not ready yet (for example, it is made lazily on
   * the first blink): this blink is skipped and tried again shortly.
   */
  set(shut: boolean): boolean | void;
}

interface Entry {
  el: Element;
  blinker: Blinker;
  inView: boolean;
  sized: boolean;
  /** Next time to shut the eyes. */
  next: number;
  /** When shut: time to open them. */
  openAt: number | null;
  /** A second blink follows this one. */
  again: boolean;
  /** This blink is the second of a double blink. */
  second: boolean;
}

const entries = new Set<Entry>();
const byElement = new Map<Element, Entry>();
let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = Infinity;
let instance = 0;
let quietUntil = 0;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pageHidden = () => typeof document !== "undefined" && document.hidden === true;
const shown = (e: Entry) => e.inView && e.sized && !pageHidden();

let io: IntersectionObserver | null | undefined;
let ro: ResizeObserver | null | undefined;
function observers() {
  if (io === undefined) {
    io =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((list) => {
            for (const item of list) {
              const e = byElement.get(item.target);
              if (!e) continue;
              // Coming into view: wait a while before the first blink, so scrolled-in rows do not all blink at once.
              if (item.isIntersecting && !e.inView) e.next = Math.max(e.next, now() + rnd(1000, GAP_MAX));
              e.inView = item.isIntersecting;
            }
            schedule();
          })
        : null;
    ro =
      typeof ResizeObserver === "function"
        ? new ResizeObserver((list) => {
            for (const item of list) {
              const e = byElement.get(item.target);
              if (e) e.sized = item.contentRect.width > 0 && item.contentRect.height > 0;
            }
            schedule();
          })
        : null;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => schedule());
      document.addEventListener(
        "scroll",
        () => {
          quietUntil = now() + SCROLL_QUIET_MS;
        },
        { capture: true, passive: true },
      );
    }
  }
}

function open(e: Entry) {
  e.blinker.set(false);
  e.openAt = null;
}

function run() {
  timer = null;
  timerAt = Infinity;
  const t = now();
  let blinking = 0;
  for (const e of entries) {
    if (e.openAt === null) continue;
    if (t >= e.openAt || !shown(e)) {
      open(e);
      if (e.again && shown(e)) {
        e.again = false;
        e.second = true;
        e.next = t + DOUBLE_GAP_MS;
      } else {
        e.second = false;
        e.next = t + rnd(GAP_MIN, GAP_MAX);
      }
    } else blinking++;
  }
  for (const e of entries) {
    if (e.openAt !== null || !shown(e) || t < e.next) continue;
    if (t < quietUntil) {
      e.next = quietUntil + rnd(200, 1500);
      continue;
    }
    if (blinking >= MAX_BLINKING) {
      // Too many at once: try again a little later, out of step with the others.
      e.next = t + rnd(300, 900);
      continue;
    }
    if (e.blinker.set(true) === false) {
      e.next = t + rnd(400, 1200);
      continue;
    }
    e.openAt = t + BLINK_SHUT_MS;
    if (!e.second) e.again = Math.random() < DOUBLE_CHANCE;
    blinking++;
  }
  schedule();
}

function schedule() {
  if (pageHidden()) {
    // Background tab: no timers at all. Shut eyes open again so nothing is left mid-blink.
    for (const e of entries) if (e.openAt !== null) open(e);
    if (timer) clearTimeout(timer);
    timer = null;
    timerAt = Infinity;
    return;
  }
  let at = Infinity;
  const t = now();
  for (const e of entries) {
    if (e.openAt !== null) at = Math.min(at, e.openAt);
    else if (shown(e)) at = Math.min(at, Math.max(e.next, t));
  }
  if (at === Infinity) {
    if (timer) clearTimeout(timer);
    timer = null;
    timerAt = Infinity;
    return;
  }
  if (timer && timerAt <= at) return;
  if (timer) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(run, Math.max(TICK_MS, at - t));
}

/**
 * Lets a still avatar blink. `seed` spreads the phase so avatars do not
 * blink together. Returns a function that stops it (and opens the eyes).
 */
export function startBlinking(el: Element, seed: string, blinker: Blinker): () => void {
  observers();
  // Phase from the seed and the instance, so copies of one seed do not blink in step.
  const phase = ((avatarIndex(seed) * 7919 + ++instance * 104729) % 5500) / 5500;
  const entry: Entry = {
    el,
    blinker,
    inView: !io,
    sized: true,
    next: now() + 600 + phase * GAP_MAX,
    openAt: null,
    again: false,
    second: false,
  };
  entries.add(entry);
  byElement.set(el, entry);
  io?.observe(el);
  ro?.observe(el);
  schedule();
  return () => {
    if (entry.openAt !== null) blinker.set(false);
    entries.delete(entry);
    byElement.delete(el);
    io?.unobserve(el);
    ro?.unobserve(el);
    schedule();
  };
}

/** Avatars taking part and how many have their eyes shut right now, for tests and diagnostics. */
export function blinkStats(): { avatars: number; shut: number; timer: boolean } {
  let shut = 0;
  for (const e of entries) if (e.openAt !== null) shut++;
  return { avatars: entries.size, shut, timer: timer !== null };
}
