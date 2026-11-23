import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountAvatar } from "../avatar.js";
import { avatarBackground, avatarSvg } from "../fallback.js";
import { AgentAvatar, type AgentAvatarHandle } from "../react.js";
import { agentAvatar } from "../rule.js";

// jsdom has no canvas: a 2D context that accepts any call, and no WebGL, which is the fallback path.
const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    type: string,
  ) {
    if (type !== "2d") return null;
    return new Proxy(
      {},
      {
        get: (_t, key) =>
          key === "canvas" ? this : (...args: unknown[]) => {
            calls.push(String(key));
            return key === "createRadialGradient" ? { addColorStop() {} } : undefined;
          },
        set: () => true,
      },
    ) as never;
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("avatarSvg", () => {
  it("is deterministic and keeps the eyes at every size", () => {
    for (const size of [16, 24, 40, 48, 96]) {
      const svg = avatarSvg("agent-1", { size });
      expect(svg).toBe(avatarSvg("agent-1", { size }));
      expect(svg.match(/<ellipse/g)).toHaveLength(2);
      expect(svg).toContain(`width="${size}"`);
      expect(svg).toContain(agentAvatar("agent-1").palette[1]);
    }
  });

  it("draws the outline, not a circle", () => {
    const look = agentAvatar("agent-3");
    expect(look.shapeName).toBe("loaf");
    expect(avatarSvg("agent-3")).toMatch(/<path id="fa-av-\d+-p" d="M/);
  });

  it("shows three bars while connecting and no eyes", () => {
    const svg = avatarSvg("agent-1", { state: "connecting" });
    expect(svg.match(/<rect/g)).toHaveLength(3);
    expect(svg).not.toContain("<ellipse");
  });

  it("fades the body on error", () => {
    expect(avatarSvg("agent-1", { state: "error" })).toContain('opacity="0.58"');
  });

  it("draws closed eyes when sleepy and arcs when happy", () => {
    expect(avatarSvg("agent-1", { state: "ended" })).toContain("M-1.15 0Q0 .75 1.15 0");
    expect(avatarSvg("agent-1", { expression: "happy" })).toContain("M-1.1 .45Q0 -1.25 1.1 .45");
  });

  it("enlarges to 1.25× the slot", () => {
    expect(avatarSvg("agent-1", { size: 40, variant: "enlarged" })).toContain('width="50"');
  });

  it("scopes its ids with idPrefix", () => {
    const a = avatarSvg("agent-1", { idPrefix: ":r1:" });
    const b = avatarSvg("agent-1", { idPrefix: ":r2:" });
    const ids = (svg: string) => [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids(a).length).toBeGreaterThan(0);
    expect(ids(a).some((id) => ids(b).includes(id))).toBe(false);
    // every reference resolves inside the same SVG
    for (const svg of [a, b]) {
      for (const [, ref] of svg.matchAll(/(?:url\(#|href="#)([^)"]+)/g)) expect(ids(svg)).toContain(ref);
    }
  });

  it("keeps the gradient fallback", () => {
    const look = agentAvatar("agent-1");
    expect(avatarBackground(look)).toContain(look.palette[1]);
  });
});

describe("mountAvatar", () => {
  it("sizes the canvas and paints a fallback body without WebGL", () => {
    const canvas = document.createElement("canvas");
    const onPaint = vi.fn();
    const avatar = mountAvatar(canvas, { id: "agent-1", size: 48, onPaint });
    expect(canvas.style.width).toBe("48px");
    expect(canvas.width).toBe(48);
    expect(onPaint).toHaveBeenCalledTimes(1);
    expect(calls).toContain("ellipse");
    avatar.update({ size: 64 });
    expect(canvas.style.height).toBe("64px");
    avatar.emote("happy");
    avatar.destroy();
  });

  it("draws enlarged avatars 1.25× and keeps their layout size", () => {
    const canvas = document.createElement("canvas");
    mountAvatar(canvas, { id: "agent-1", size: 40, variant: "enlarged" }).destroy();
    expect(canvas.style.width).toBe("50px");
    expect(canvas.style.margin).toBe("-5px");
  });

  it("does nothing without a 2D context", () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const avatar = mountAvatar(document.createElement("canvas"), { id: "a", size: 40 });
    expect(() => {
      avatar.update({ state: "speaking" });
      avatar.emote("sad");
      avatar.destroy();
    }).not.toThrow();
  });
});

describe("AgentAvatar", () => {
  it("renders a still SVG on the server", () => {
    const html = renderToString(<AgentAvatar agentId="agent-1" size={24} state="listening" />);
    expect(html).toContain("<svg");
    expect(html.match(/<ellipse/g)).toHaveLength(2);
    expect(html).toContain('data-state="listening"');
  });

  it("gives each copy of the same seed its own ids, so a hidden copy cannot break the others", () => {
    const html = renderToString(
      <div>
        <div style={{ display: "none" }}>
          <AgentAvatar agentId="agent-1" size={24} />
        </div>
        <AgentAvatar agentId="agent-1" size={24} />
      </div>,
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.append(host);
    const svgs = host.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    const all = [...host.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(all).size).toBe(all.length);
    // the visible copy's references resolve to elements inside that copy, not the hidden one
    const visible = svgs[1]!;
    for (const el of visible.querySelectorAll("[fill^='url(#'], use")) {
      const ref = (el.getAttribute("href") ?? el.getAttribute("fill")!).replace(/^url\(#|\)$/g, "").replace(/^#/, "");
      expect(visible.contains(document.getElementById(ref))).toBe(true);
    }
    host.remove();
  });

  it("is decorative unless labelled", () => {
    const { container } = render(<AgentAvatar agentId="agent-1" size={32} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute("aria-hidden")).toBe("true");
    expect(root.style.width).toBe("32px");
    cleanup();
    const labelled = render(<AgentAvatar agentId="agent-1" aria-label="Support agent" />);
    expect(labelled.container.firstElementChild!.getAttribute("role")).toBe("img");
  });

  it("stays a still SVG without WebGL, with no canvas", () => {
    const { container } = render(<AgentAvatar agentId="agent-1" size={40} />);
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.firstElementChild!.getAttribute("data-render")).toBe("svg");
  });

  it("keeps the slot size when enlarged", () => {
    const { container } = render(<AgentAvatar agentId="agent-1" size={40} variant="enlarged" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.width).toBe("40px");
    expect((root.firstElementChild as HTMLElement).style.width).toBe("50px");
  });

  it("plays an event expression through its ref", () => {
    const ref = createRef<AgentAvatarHandle>();
    render(<AgentAvatar ref={ref} agentId="agent-1" size={64} animated />);
    expect(ref.current).not.toBeNull();
    act(() => ref.current!.emote("happy"));
  });
});
