import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountAvatar, type AvatarHandle } from "../avatar.js";
import { Face } from "../face.js";
import { avatarLook } from "../rule.js";

// A hand-driven frame loop, observers we can trigger, and a 2D context that counts frames per canvas.
let frames: Array<FrameRequestCallback> = [];
let requested = 0;
let clock = 0;
const intersection = new Map<Element, (visible: boolean) => void>();
const resize = new Map<Element, (w: number) => void>();
const draws = new Map<HTMLCanvasElement, number>();

function step(n = 1) {
  for (let i = 0; i < n; i++) {
    const run = frames;
    frames = [];
    clock += 16;
    for (const cb of run) cb(clock);
  }
}

beforeEach(() => {
  frames = [];
  requested = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    requested++;
    frames.push(cb);
    return frames.length;
  });
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private cb: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe(el: Element) {
        intersection.set(el, (visible) => this.cb([{ isIntersecting: visible }]));
      }
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private cb: (entries: Array<{ contentRect: { width: number; height: number } }>) => void) {}
      observe(el: Element) {
        resize.set(el, (w) => this.cb([{ contentRect: { width: w, height: w } }]));
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    type: string,
  ) {
    if (type !== "2d") return null;
    const canvas = this;
    return new Proxy(
      {},
      {
        get: (_t, key) =>
          key === "canvas"
            ? canvas
            : (..._args: unknown[]) => {
                if (key === "clearRect") draws.set(canvas, (draws.get(canvas) ?? 0) + 1);
                return key === "createRadialGradient" ? { addColorStop() {} } : undefined;
              },
        set: () => true,
      },
    ) as never;
  } as never);
});

afterEach(() => {
  for (const h of handles) h.destroy();
  handles.length = 0;
  step(2);
  intersection.clear();
  resize.clear();
  draws.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const handles: AvatarHandle[] = [];
function mount(size = 64) {
  const canvas = document.createElement("canvas");
  const handle = mountAvatar(canvas, { id: "agent-1", size, animated: true });
  handles.push(handle);
  return { canvas, handle };
}
/** Frames requested over the next `n` frames. */
function requestsOver(n: number) {
  const before = requested;
  step(n);
  return requested - before;
}

describe("frame loop", () => {
  it("stops when the only animated avatar is hidden with display: none", () => {
    const { canvas } = mount();
    expect(requestsOver(5)).toBe(5);
    resize.get(canvas)!(0); // display: none
    step(1);
    expect(requestsOver(30)).toBe(0);
  });

  it("stops when the avatar scrolls out of view, and resumes when it comes back", () => {
    const { canvas } = mount();
    step(2);
    intersection.get(canvas)!(false);
    step(1);
    expect(requestsOver(30)).toBe(0);
    const before = draws.get(canvas)!;
    intersection.get(canvas)!(true);
    expect(requestsOver(5)).toBe(5);
    expect(draws.get(canvas)!).toBeGreaterThan(before);
  });

  it("resumes after display: none is lifted", () => {
    const { canvas } = mount();
    resize.get(canvas)!(0);
    step(2);
    expect(requestsOver(10)).toBe(0);
    resize.get(canvas)!(64);
    expect(requestsOver(5)).toBe(5);
  });

  it("only draws the visible avatars when some are hidden", () => {
    const a = mount();
    const b = mount();
    const c = mount();
    step(2);
    resize.get(b.canvas)!(0);
    intersection.get(c.canvas)!(false);
    step(1);
    const before = [a, b, c].map((x) => draws.get(x.canvas)!);
    step(20);
    const after = [a, b, c].map((x) => draws.get(x.canvas)!);
    expect(after[0]! - before[0]!).toBe(20);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(requestsOver(5)).toBe(5);
  });

  it("stops while the tab is in the background", () => {
    mount();
    step(2);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    step(1);
    expect(requestsOver(10)).toBe(0);
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(requestsOver(3)).toBe(3);
  });

  it("keeps state changes made while hidden", () => {
    const { canvas, handle } = mount();
    resize.get(canvas)!(0);
    step(2);
    handle.update({ state: "connecting" });
    expect(requestsOver(10)).toBe(0);
    resize.get(canvas)!(64);
    expect(requestsOver(3)).toBe(3);
  });
});

describe("Face.fastForward", () => {
  const opts = { size: 64, state: "idle" as const, animated: true, reducedMotion: false, interactive: true };

  it("does not replay an event expression that ended while hidden", () => {
    const face = new Face(avatarLook("agent-1"), opts);
    face.emote("happy", 1300);
    face.step(0.1);
    face.fastForward(5);
    const pose = face.step(0);
    expect(pose.eyes[0].glyphs.happy).toBe(0);
    expect(pose.eyes[0].glyphs.oval).toBe(1);
  });

  it("lets an event expression that is still running finish", () => {
    const face = new Face(avatarLook("agent-1"), opts);
    face.emote("happy", 1300);
    face.fastForward(0.5);
    for (let i = 0; i < 20; i++) face.step(1 / 60);
    expect(face.step(0).eyes[0].glyphs.happy).toBeGreaterThan(0.9);
  });

  it("keeps the state's expression", () => {
    const face = new Face(avatarLook("agent-1"), { ...opts, state: "ended" });
    face.fastForward(30);
    expect(face.step(0).eyes[0].glyphs.closed).toBe(1);
  });
});
