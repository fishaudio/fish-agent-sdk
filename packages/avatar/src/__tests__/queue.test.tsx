import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each body draw "takes" 3 ms on a clock we control.
let fakeNow = 0;
vi.mock("../renderer.js", () => ({
  hasWebGL: () => true,
  prepareRenderer: () => Promise.resolve(true),
  drawBody: () => {
    fakeNow += 3;
    return true;
  },
}));

const { acquireAvatarImage, avatarImageStats, clearAvatarImages, resetAvatarImages, DRAW_BUDGET_MS } = await import("../image.js");
const { encoderPath, resetEncoder } = await import("../encode.js");
const { AgentAvatar } = await import("../react.js");
type Handle = import("../react.js").AgentAvatarHandle;

let blobs = 0;
let toBlobCalls = 0;
let toBlobDelay = 0;
const observed = new Map<Element, Array<(inView: boolean) => void>>();

beforeEach(() => {
  vi.useFakeTimers();
  fakeNow = 0;
  toBlobCalls = 0;
  toBlobDelay = 0;
  vi.spyOn(performance, "now").mockImplementation(() => fakeNow + Date.now());
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {}
      observe(el: Element) {
        const list = observed.get(el) ?? [];
        list.push((v) => this.cb([{ target: el, isIntersecting: v }]));
        observed.set(el, list);
      }
      unobserve() {}
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
            : () =>
                key === "createRadialGradient"
                  ? { addColorStop() {} }
                  : key === "getImageData"
                    ? { data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }
                    : undefined,
        set: () => true,
      },
    ) as never;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback) => {
    toBlobCalls++;
    if (toBlobDelay) setTimeout(() => cb(new Blob(["png"])), toBlobDelay);
    else cb(new Blob(["png"]));
  });
  vi.stubGlobal("URL", Object.assign(Object.create(URL), {
    createObjectURL: () => `blob:img-${++blobs}`,
    revokeObjectURL: () => {},
  }));
  resetEncoder();
});

afterEach(() => {
  cleanup();
  clearAvatarImages();
  resetAvatarImages();
  observed.clear();
  resetEncoder();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs idle slices, encoding and React updates for `ms` of fake time. */
const run = (ms = 600) =>
  act(async () => {
    for (let t = 0; t < ms; t += 10) {
      vi.advanceTimersByTime(10);
      for (let j = 0; j < 5; j++) await Promise.resolve();
    }
  });
function show(el: Element, visible = true) {
  act(() => {
    for (const cb of observed.get(el) ?? []) cb(visible);
  });
}

describe("image queue", () => {
  it("makes images only for avatars on screen, in the order they come into view", async () => {
    const before = avatarImageStats().renders;
    const { container } = render(
      <div>
        <AgentAvatar agentId="q-a" size={24} />
        <AgentAvatar agentId="q-b" size={24} />
        <AgentAvatar agentId="q-c" size={24} />
      </div>,
    );
    const [a, b, c] = [...container.querySelectorAll("[data-agent-avatar]")];
    await run();
    expect(avatarImageStats().renders - before).toBe(0);
    show(b!);
    await run();
    expect(avatarImageStats().renders - before).toBe(1);
    expect((b as HTMLElement).dataset.render).toBe("image");
    // Off screen and mounted on the client: only a light dot in the avatar's colour, no SVG, no canvas.
    expect((a as HTMLElement).dataset.render).toBe("placeholder");
    expect((c as HTMLElement).dataset.render).toBe("placeholder");
    expect(a!.querySelector("svg")).toBeNull();
    show(c!);
    show(a!);
    await run();
    expect(avatarImageStats().renders - before).toBe(3);
  });

  it("drops images released before they are made", async () => {
    const before = avatarImageStats().renders;
    const image = acquireAvatarImage("dropped", { dpr: 1 });
    image.release();
    await run();
    expect(avatarImageStats().renders - before).toBe(0);
    expect(await image.ready).toBeNull();
  });

  it("draws only a few frames per slice, within the budget", async () => {
    const before = avatarImageStats().renders;
    const images = Array.from({ length: 20 }, (_, i) => acquireAvatarImage(`budget-${i}`, { dpr: 1 }));
    // One slice (after the renderer is ready)
    await act(async () => {
      for (let j = 0; j < 5; j++) await Promise.resolve();
      vi.advanceTimersToNextTimer();
    });
    const first = avatarImageStats().renders - before;
    expect(first).toBeGreaterThanOrEqual(1);
    expect(first).toBeLessThanOrEqual(Math.ceil(DRAW_BUDGET_MS / 3));
    await run(2000);
    expect(avatarImageStats().renders - before).toBe(20);
    for (const i of images) i.release();
  });

  it("puts urgent images first", async () => {
    const order: string[] = [];
    const images = ["u1", "u2", "u3"].map((s) => acquireAvatarImage(s, { dpr: 1 }));
    const urgent = acquireAvatarImage("u-now", { dpr: 1, urgent: true });
    for (const [i, img] of [...images, urgent].entries()) void img.ready.then(() => order.push(i === 3 ? "u-now" : `u${i + 1}`));
    await run(1000);
    expect(order[0]).toBe("u-now");
    for (const i of [...images, urgent]) i.release();
  });

  it("serves a remounted avatar from the cache on its first render", async () => {
    const first = render(<AgentAvatar agentId="again" size={24} />);
    show(first.container.firstElementChild!);
    await run();
    const renders = avatarImageStats().renders;
    first.unmount();
    await run(50);
    const { container } = render(<AgentAvatar agentId="again" size={24} />);
    // No SVG step and no new render: the cached image shows straight away.
    expect((container.firstElementChild as HTMLElement).dataset.render).toBe("image");
    await run();
    expect(avatarImageStats().renders).toBe(renders);
  });
});

describe("encoding", () => {
  it("draws and encodes in the worker when it can", async () => {
    const posted: unknown[] = [];
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: ((e: { data: unknown }) => void) | null = null;
        onerror: (() => void) | null = null;
        postMessage(data: { id: number }) {
          posted.push(data);
          setTimeout(() => this.onmessage?.({ data: { id: data.id, blob: new Blob(["png"]) } }), 5);
        }
        terminate() {}
      },
    );
    expect(encoderPath()).toBe("worker");
    const image = acquireAvatarImage("in-worker", { dpr: 1 });
    await run();
    expect(await image.ready).toMatch(/^blob:/);
    expect(posted).toHaveLength(1);
    expect((posted[0] as { type: string }).type).toBe("render");
    expect(toBlobCalls).toBe(0);
    image.release();
  });

  it("draws on the page and encodes in the worker when the worker has no WebGL", async () => {
    const types: string[] = [];
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal(
      "Worker",
      class {
        onmessage: ((e: { data: unknown }) => void) | null = null;
        postMessage(data: { id: number; type: string }) {
          types.push(data.type);
          const reply = data.type === "render" ? { id: data.id, blob: null, failed: true } : { id: data.id, blob: new Blob(["png"]) };
          setTimeout(() => this.onmessage?.({ data: reply }), 5);
        }
        terminate() {}
      },
    );
    const a = acquireAvatarImage("no-gl-worker-a", { dpr: 1 });
    await run();
    const b = acquireAvatarImage("no-gl-worker-b", { dpr: 1 });
    await run();
    expect(await a.ready).toMatch(/^blob:/);
    expect(await b.ready).toMatch(/^blob:/);
    // One failed render, then the page draws and the worker only encodes.
    expect(types).toEqual(["render", "encode", "encode"]);
    expect(toBlobCalls).toBe(0);
    a.release();
    b.release();
  });

  it("falls back to the main thread when the worker breaks", async () => {
    vi.stubGlobal("OffscreenCanvas", class {});
    vi.stubGlobal(
      "Worker",
      class {
        onerror: ((e: { preventDefault(): void }) => void) | null = null;
        postMessage() {
          setTimeout(() => this.onerror?.({ preventDefault() {} }), 5);
        }
        terminate() {}
      },
    );
    const image = acquireAvatarImage("worker-broke", { dpr: 1 });
    await run();
    expect(await image.ready).toMatch(/^blob:/);
    expect(toBlobCalls).toBe(1);
    image.release();
  });

  it("encodes on the main thread, one per idle slice, without Worker or OffscreenCanvas", async () => {
    expect(encoderPath()).toBe("main");
    const images = Array.from({ length: 3 }, (_, i) => acquireAvatarImage(`main-${i}`, { dpr: 1 }));
    await run();
    expect(toBlobCalls).toBe(3);
    for (const i of images) expect(await i.ready).toMatch(/^blob:/);
    for (const i of images) i.release();
  });
});

describe("event expressions on still avatars", () => {
  async function mounted(seed: string) {
    const ref = createRef<Handle>();
    const { container } = render(<AgentAvatar ref={ref} agentId={seed} size={24} />);
    const root = container.firstElementChild as HTMLElement;
    show(root);
    await run();
    expect(root.dataset.render).toBe("image");
    return { ref, root };
  }
  const happyShowing = (root: HTMLElement, normal: string) =>
    root.dataset.render === "svg"
      ? root.innerHTML.includes("M-1.1 .45Q0 -1.25 1.1 .45")
      : root.querySelector("img")!.getAttribute("src") !== normal;

  it("times the expression from when it is shown", async () => {
    const { ref, root } = await mounted("emote-fast");
    const normal = root.querySelector("img")!.getAttribute("src")!;
    act(() => ref.current!.emote("happy", 1300));
    await run(150); // the happy image is made and shown
    expect(happyShowing(root, normal)).toBe(true);
    await run(1100);
    expect(happyShowing(root, normal)).toBe(true);
    await run(300);
    expect(happyShowing(root, normal)).toBe(false);
  });

  it("shows a slow expression as SVG after 300 ms and still holds it for the full time", async () => {
    const { ref, root } = await mounted("emote-slow");
    const normal = root.querySelector("img")!.getAttribute("src")!;
    toBlobDelay = 700;
    act(() => ref.current!.emote("happy", 1300));
    await run(320);
    expect(root.dataset.render).toBe("svg");
    expect(happyShowing(root, normal)).toBe(true);
    await run(1200); // 1.52 s after the call, 1.2 s after it showed
    expect(happyShowing(root, normal)).toBe(true);
    await run(300);
    expect(happyShowing(root, normal)).toBe(false);
  });
});
