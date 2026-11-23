import { describe, expect, it } from "vitest";
import {
  agentAvatar,
  AVATAR_COLORS,
  avatarIndex,
  avatarLook,
  DARK_EYES_ABOVE,
  expandPalette,
  eyeScaleFor,
  luminance,
} from "../rule.js";
import { AVATAR_SHAPES, avatarShape, polygonArea } from "../shapes.js";
import golden from "./rule-golden.json";

describe("avatarLook", () => {
  // Any renderer, on any platform, must agree with these. Updating them changes every agent's face.
  it.each(golden)("matches the golden look for $id", (expected) => {
    const look = agentAvatar(expected.id, 40);
    expect(look.n).toBe(expected.n);
    expect(look.shape).toBe(expected.shape);
    expect(look.shapeName).toBe(expected.shapeName);
    expect(look.color).toBe(expected.color);
    expect(look.main).toBe(expected.main);
    expect(look.palette).toEqual(expected.palette);
    expect(look.eyeColor).toBe(expected.eyeColor);
    expect(look.seed).toBe(expected.seed);
    expect(look.flowAngle).toBeCloseTo(expected.flowAngle, 9);
    expect(look.eyes.anchor).toEqual(expected.eyeAnchor);
  });

  it("is the same for the same seed and independent of size", () => {
    const { eyes: _a, ...small } = agentAvatar("agent-7", 16);
    const { eyes: _b, ...large } = agentAvatar("agent-7", 160);
    expect(small).toEqual(large);
    expect(avatarLook("agent-7")).toEqual(avatarLook("agent-7"));
    expect(small).toEqual(avatarLook("agent-7"));
  });

  it("reaches every outline and every colour", () => {
    const shapes = new Set<number>();
    const colors = new Set<number>();
    const pairs = new Set<string>();
    for (let i = 0; i < 4000; i++) {
      const look = avatarLook(`agent-${i}`);
      shapes.add(look.shape);
      colors.add(look.color);
      pairs.add(`${look.shape}/${look.color}`);
    }
    expect(shapes.size).toBe(18);
    expect(colors.size).toBe(13);
    expect(pairs.size).toBe(18 * 13);
  });

  it("uses only the 13 restrained colours", () => {
    expect(AVATAR_COLORS).toHaveLength(13);
    for (let i = 0; i < 300; i++) {
      const look = avatarLook(`seed-${i}`);
      expect(AVATAR_COLORS).toContain(look.main);
      expect(look.palette[1]).toBe(look.main.toLowerCase());
    }
  });

  it("puts dark eyes only on very light bodies", () => {
    for (const main of AVATAR_COLORS) expect(avatarLook(main).eyeColor).toBe("#FFFFFF");
    expect(luminance("#F4F1EA")).toBeGreaterThan(DARK_EYES_ABOVE);
    expect(expandPalette("#F4F1EA")).toHaveLength(6);
  });

  it("reduces any seed to 0–99999", () => {
    for (const id of ["", "a", "🐟", "x".repeat(500)]) {
      const n = avatarIndex(id);
      expect(Number.isInteger(n) && n >= 0 && n < 100000).toBe(true);
    }
  });

  it("grows the eyes on small avatars", () => {
    expect(eyeScaleFor(16)).toBe(1.45);
    expect(eyeScaleFor(24)).toBe(1.45);
    expect(eyeScaleFor(40)).toBe(1.25);
    expect(eyeScaleFor(48)).toBe(1.25);
    expect(eyeScaleFor(96)).toBe(1.15);
    expect(agentAvatar("Beau", 16).eyes).not.toBeNull();
  });
});

describe("outlines", () => {
  it("has 18 full, rounded outlines of about the same area", () => {
    expect(AVATAR_SHAPES).toHaveLength(18);
    const circle = Math.PI * 0.92 * 0.92;
    AVATAR_SHAPES.forEach((name, i) => {
      const shape = avatarShape(i);
      expect(shape.name).toBe(name);
      // Equal area, unless the 1.04 extent cap shrinks a wide outline a little.
      const area = polygonArea(shape.points) / circle;
      expect(area).toBeGreaterThan(0.94);
      expect(area).toBeLessThan(1.001);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of shape.points) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
      expect(Math.max(x1 - x0, y1 - y0) / 2).toBeLessThanOrEqual(1.04 + 1e-9);
      // The shader's lookup table is a closed outline around the centre.
      expect(Math.min(...shape.radii)).toBeGreaterThan(0.5);
      expect(shape.path.startsWith("M")).toBe(true);
    });
  });
});
