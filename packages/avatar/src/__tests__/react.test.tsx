import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { avatarBackground } from "../fallback.js";
import { mountAvatar } from "../avatar.js";
import { AgentAvatar } from "../react.js";
import { agentAvatar } from "../rule.js";

// jsdom has no canvas: a 2D context stub, and no WebGL, which is the fallback path.
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    type: string,
  ) {
    return type === "2d" ? ({ clearRect() {}, drawImage() {} } as never) : null;
  } as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("mountAvatar", () => {
  it("sizes the canvas and stays blank without WebGL", () => {
    const canvas = document.createElement("canvas");
    const onPaint = vi.fn();
    const avatar = mountAvatar(canvas, { id: "agent-1", size: 48, onPaint });
    expect(canvas.style.width).toBe("48px");
    expect(canvas.width).toBe(48);
    expect(onPaint).not.toHaveBeenCalled();
    avatar.update({ size: 64 });
    expect(canvas.style.height).toBe("64px");
    avatar.destroy();
  });
});

describe("AgentAvatar", () => {
  it("shows the palette fallback until a frame is painted", () => {
    const { container } = render(<AgentAvatar agentId="agent-1" size={32} />);
    const canvas = container.querySelector("canvas")!;
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.style.width).toBe("32px");
    // jsdom cannot parse layered gradients, so the fallback itself is checked here.
    const look = agentAvatar("agent-1");
    expect(avatarBackground(look)).toContain(look.palette[1]);
  });

  it("is an image when labelled", () => {
    const { container } = render(<AgentAvatar agentId="agent-1" aria-label="Support agent" />);
    expect(container.querySelector("canvas")!.getAttribute("role")).toBe("img");
  });
});
