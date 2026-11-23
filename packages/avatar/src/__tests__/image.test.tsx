import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// WebGL is "available": the body draw succeeds without a GPU.
vi.mock("../renderer.js", () => ({ hasWebGL: () => true, prepareRenderer: () => Promise.resolve(true), drawBody: () => true }));

const { acquireAvatarImage, avatarImageStats, clearAvatarImages, resetAvatarImages, IDLE_IMAGE_LIMIT } = await import("../image.js");
const { AgentAvatar } = await import("../react.js");

let frames: FrameRequestCallback[] = [];
let clock = 0;
let blobs = 0;
const revoked: string[] = [];

function step(n = 1) {
  for (let i = 0; i < n; i++) {
    const run = frames;
    frames = [];
    clock += 16;
    for (const cb of run) cb(clock);
  }
}
// The queue runs in idle slices (setTimeout here) and encodes on the main thread fallback (no Worker in jsdom).
const flush = () =>
  act(async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 20));
  });

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.spyOn(performance, "now").mockImplementation(() => clock);
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
    revokeObjectURL: (url: string) => revoked.push(url),
  }));
});

afterEach(() => {
  cleanup();
  clearAvatarImages();
  resetAvatarImages();
  revoked.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("acquireAvatarImage", () => {
  it("renders once for 100 users of the same seed", async () => {
    const before = avatarImageStats().renders;
    const images = Array.from({ length: 100 }, () => acquireAvatarImage("shared", { size: 24, dpr: 2 }));
    const urls = await Promise.all(images.map((i) => i.ready));
    expect(avatarImageStats().renders - before).toBe(1);
    expect(new Set(urls).size).toBe(1);
    expect(urls[0]).toMatch(/^blob:/);
    for (const i of images) i.release();
    expect(avatarImageStats().idle).toBe(1);
  });

  it("keys by size, state, expression and variant", async () => {
    const before = avatarImageStats().renders;
    const a = acquireAvatarImage("k", { size: 24, dpr: 1 });
    const b = acquireAvatarImage("k", { size: 24, dpr: 1, state: "error" });
    const c = acquireAvatarImage("k", { size: 24, dpr: 1, expression: "happy" });
    const d = acquireAvatarImage("k", { size: 24, dpr: 1, variant: "enlarged" });
    const e = acquireAvatarImage("k", { size: 24, dpr: 2 });
    await Promise.all([a, b, c, d, e].map((i) => i.ready));
    expect(avatarImageStats().renders - before).toBe(5);
    expect(d.cssSize).toBe(30);
    for (const i of [a, b, c, d, e]) i.release();
  });

  it("frees unused images beyond the idle limit, oldest first, and on clear", async () => {
    const images = Array.from({ length: IDLE_IMAGE_LIMIT + 10 }, (_, i) => acquireAvatarImage(`seed-${i}`, { dpr: 1 }));
    await Promise.all(images.map((i) => i.ready));
    const first = images[0]!.url;
    for (const i of images) i.release();
    expect(avatarImageStats().idle).toBe(IDLE_IMAGE_LIMIT);
    expect(revoked).toHaveLength(10);
    expect(revoked[0]).toBe(first);
    clearAvatarImages();
    expect(avatarImageStats()).toMatchObject({ images: 0, idle: 0 });
  });

  it("keeps images that are still in use", async () => {
    const held = acquireAvatarImage("held", { dpr: 1 });
    await held.ready;
    clearAvatarImages();
    expect(avatarImageStats().images).toBe(1);
    held.release();
    clearAvatarImages();
    expect(avatarImageStats().images).toBe(0);
  });
});

describe("AgentAvatar rendering", () => {
  it("shows still avatars as images with no canvas, one render for 100 copies", async () => {
    const before = avatarImageStats().renders;
    const { container } = render(
      <div>
        {Array.from({ length: 100 }, (_, i) => (
          <AgentAvatar key={i} agentId="list-seed" size={24} />
        ))}
      </div>,
    );
    await flush();
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
    expect(container.querySelectorAll("img")).toHaveLength(100);
    expect(avatarImageStats().renders - before).toBe(1);
  });

  it("uses an image for animated avatars that cannot move: small, enlarged or reduced motion", async () => {
    const { container } = render(
      <div>
        <AgentAvatar agentId="a" size={24} animated />
        <AgentAvatar agentId="a" size={64} animated variant="enlarged" />
        <AgentAvatar agentId="a" size={64} animated reducedMotion />
      </div>,
    );
    await flush();
    expect(container.querySelectorAll("canvas")).toHaveLength(0);
    expect(container.querySelectorAll("img")).toHaveLength(3);
  });

  it("switches to a canvas on hover and back to the image once it settles", async () => {
    const { container } = render(<AgentAvatar agentId="hover-seed" size={40} />);
    await flush();
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.render).toBe("image");
    fireEvent.pointerEnter(root);
    expect(root.dataset.render).toBe("canvas");
    expect(container.querySelector("canvas")).not.toBeNull();
    // The image stays underneath, hidden, until the canvas hands back.
    expect(container.querySelector("img")!.style.visibility).toBe("hidden");
    await act(async () => {
      step(3);
    });
    await flush();
    expect(root.dataset.render).toBe("image");
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("img")!.style.visibility).toBe("");
  });

  it("keeps a canvas for animated avatars that can move", async () => {
    const { container } = render(<AgentAvatar agentId="live" size={64} animated />);
    await flush();
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("shows an event expression as an image where it cannot move", async () => {
    const ref = { current: null as null | { emote(e: "happy", ms?: number): void } };
    const before = avatarImageStats().renders;
    const { container } = render(<AgentAvatar ref={ref as never} agentId="small-emote" size={24} />);
    await flush();
    act(() => ref.current!.emote("happy", 1000));
    await flush();
    expect(container.querySelector("canvas")).toBeNull();
    expect(avatarImageStats().renders - before).toBe(2);
  });

  it("releases its image when unmounted", async () => {
    const { unmount } = render(<AgentAvatar agentId="gone" size={24} />);
    await flush();
    const idle = avatarImageStats().idle;
    unmount();
    await flush();
    expect(avatarImageStats().idle).toBe(idle + 1);
  });
});
