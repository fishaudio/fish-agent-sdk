import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../renderer.js", () => ({ hasWebGL: () => true, drawBody: () => true }));

const { AgentAvatar } = await import("../react.js");
const { blinkStats, BLINK_SHUT_MS, MAX_BLINKING } = await import("../blink.js");
const { clearAvatarImages } = await import("../image.js");

let blobs = 0;
const observed = new Map<Element, (inView: boolean) => void>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {}
      observe(el: Element) {
        observed.set(el, (inView) => this.cb([{ target: el, isIntersecting: inView }]));
      }
      unobserve(el: Element) {
        observed.delete(el);
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
          key === "canvas" ? canvas : () => (key === "createRadialGradient" ? { addColorStop() {} } : undefined),
        set: () => true,
      },
    ) as never;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb: BlobCallback) => cb(new Blob(["png"])));
  vi.stubGlobal("URL", Object.assign(Object.create(URL), {
    createObjectURL: () => `blob:avatar-${++blobs}`,
    revokeObjectURL: () => {},
  }));
});

afterEach(() => {
  cleanup();
  clearAvatarImages();
  observed.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
function showAll() {
  act(() => {
    for (const [, cb] of observed) cb(true);
  });
}
/** Runs the clock in 10 ms steps and records each avatar image's src over time. */
function watch(container: HTMLElement, ms: number) {
  const seen: string[][] = [];
  const imgs = [...container.querySelectorAll("img")];
  let maxShut = 0;
  for (let t = 0; t < ms; t += 10) {
    act(() => {
      vi.advanceTimersByTime(10);
    });
    seen.push(imgs.map((i) => i.getAttribute("src")!));
    maxShut = Math.max(maxShut, blinkStats().shut);
  }
  return { seen, maxShut };
}

describe("blinks on small still avatars", () => {
  it.each([16, 24])("swaps %ipx avatars to the shut-eye image and back, with no canvas", async (size) => {
    const { container } = render(<AgentAvatar agentId="blinker" size={size} animated />);
    await settle();
    showAll();
    const img = container.querySelector("img")!;
    const open = img.getAttribute("src");
    const { seen } = watch(container, 9000);
    const srcs = seen.map((s) => s[0]);
    const shut = srcs.filter((s) => s !== open);
    expect(shut.length).toBeGreaterThan(0);
    // shut for about BLINK_SHUT_MS each time, then open again
    const runs: number[] = [];
    let run = 0;
    for (const s of srcs) {
      if (s !== open) run += 10;
      else if (run) {
        runs.push(run);
        run = 0;
      }
    }
    expect(Math.max(...runs)).toBeLessThanOrEqual(BLINK_SHUT_MS + 10);
    expect(srcs.at(-1) === open || run > 0).toBe(true);
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("does not blink with reduced motion", async () => {
    const { container } = render(<AgentAvatar agentId="still" size={16} animated reducedMotion />);
    await settle();
    showAll();
    const open = container.querySelector("img")!.getAttribute("src");
    const { seen } = watch(container, 9000);
    expect(seen.every((s) => s[0] === open)).toBe(true);
    expect(blinkStats().avatars).toBe(0);
  });

  it("does not blink while out of view", async () => {
    const { container } = render(<AgentAvatar agentId="hidden" size={16} animated />);
    await settle();
    act(() => {
      for (const [, cb] of observed) cb(false);
    });
    const open = container.querySelector("img")!.getAttribute("src");
    const { seen } = watch(container, 9000);
    expect(seen.every((s) => s[0] === open)).toBe(true);
    expect(blinkStats().timer).toBe(false);
  });

  it("does not blink in a background tab", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const { container } = render(<AgentAvatar agentId="tab" size={16} animated />);
    await settle();
    showAll();
    const open = container.querySelector("img")!.getAttribute("src");
    const { seen } = watch(container, 9000);
    expect(seen.every((s) => s[0] === open)).toBe(true);
    hidden.mockRestore();
  });

  it("does not blink still avatars that are not animated, or eyes that are not open", async () => {
    const { container } = render(
      <div>
        <AgentAvatar agentId="a" size={16} />
        <AgentAvatar agentId="b" size={16} animated state="ended" />
        <AgentAvatar agentId="c" size={16} animated expression="happy" />
      </div>,
    );
    await settle();
    showAll();
    expect(blinkStats().avatars).toBe(0);
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
  });

  it("lets only a few of a long list blink at once", async () => {
    const { container } = render(
      <div>
        {Array.from({ length: 60 }, (_, i) => (
          <AgentAvatar key={i} agentId={`row-${i % 6}`} size={24} animated />
        ))}
      </div>,
    );
    await settle();
    showAll();
    expect(blinkStats().avatars).toBe(60);
    const { seen, maxShut } = watch(container, 12000);
    expect(maxShut).toBeLessThanOrEqual(MAX_BLINKING);
    const blinked = new Set<number>();
    for (const s of seen) s.forEach((src, i) => src !== seen[0]![i] && blinked.add(i));
    expect(blinked.size).toBeGreaterThan(40);
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
  });
});
